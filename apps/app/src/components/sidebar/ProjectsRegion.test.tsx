// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ProjectSource } from "@bb/domain";
import type { ProjectWithThreadsResponse } from "@bb/server-contract";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { appToast } from "@/components/ui/app-toast";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import {
  createAppPanelController,
  UNAVAILABLE_APP_PANEL_CONTROLLER,
  type AppPanelController,
} from "@/lib/app-fixed-tab-navigation";
import { sdk } from "@/lib/sdk";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ProjectsRegion } from "./ProjectsRegion";

const THIS_HOST_ID = "host_this";
const OTHER_HOST_ID = "host_other";

interface FakeNavigationSurface {
  openFilePreview: (intent: unknown) => boolean;
  panel: AppPanelController;
}

const navigation = vi.hoisted(
  (): { surface: FakeNavigationSurface | null } => ({ surface: null }),
);

vi.mock("@/lib/sdk", () => ({
  BbHttpError: class BbHttpError extends Error {},
  sdk: { projects: { directory: vi.fn() } },
}));

vi.mock("@/lib/app-navigation-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation-host")>()),
  getFocusedAppNavigationSurface: () => navigation.surface,
}));

vi.mock("@/components/ui/app-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ui/app-toast")>();
  return { ...actual, appToast: { ...actual.appToast, error: vi.fn() } };
});

vi.mock("@/hooks/useLocalPathPicker", () => ({
  usePathPickerHost: () => ({
    canUseNativeFolderPicker: false,
    clientHostId: "host_this",
    hostId: "host_this",
    hostName: "This host",
  }),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    isAvailable: true,
    openCreateDialog: () => {},
  }),
}));

function makeProject(sourceHostId: string): ProjectWithThreadsResponse {
  const source: ProjectSource = {
    id: "src_alpha",
    projectId: "proj_alpha",
    type: "local_path",
    hostId: sourceHostId,
    path: "/repo/alpha",
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
  return makeProjectWithThreadsResponse({
    id: "proj_alpha",
    name: "Alpha",
    sources: [source],
  });
}

function renderRegion(projects: ProjectWithThreadsResponse[] | null) {
  const { queryClient, wrapper: Wrapper } = createQueryClientTestHarness();
  if (projects !== null) {
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarBootstrapResponse({ projects }),
    );
  }
  render(
    <Wrapper>
      <ProjectsRegion />
    </Wrapper>,
  );
}

describe("ProjectsRegion", () => {
  let consoleError: MockInstance<typeof console.error>;

  function updateDepthErrors() {
    return consoleError.mock.calls
      .flat()
      .map(String)
      .filter((message) => message.includes("Maximum update depth"));
  }

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(240);
  });

  afterEach(() => {
    cleanup();
    navigation.surface = null;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it.each([
    { state: "roots not loaded yet", projects: null, text: "Projects" },
    { state: "no project roots", projects: [], text: "No project folders" },
    {
      state: "one root with a source",
      projects: [makeProject(THIS_HOST_ID)],
      text: "Alpha",
    },
    {
      state: "one root with no source on this host",
      projects: [makeProject(OTHER_HOST_ID)],
      text: "Not on this host",
    },
  ])("settles with $state", async ({ projects, text }) => {
    renderRegion(projects);

    expect(await screen.findByText(text)).toBeTruthy();
    expect(updateDepthErrors()).toEqual([]);
  });

  it("settles after an open folder finishes listing", async () => {
    vi.mocked(sdk.projects.directory).mockResolvedValue({
      entries: [{ kind: "directory", name: "src", path: "src" }],
      truncated: false,
    });
    renderRegion([makeProject(THIS_HOST_ID)]);

    fireEvent.click(await screen.findByText("Alpha"));

    expect(await screen.findByText("src")).toBeTruthy();
    expect(sdk.projects.directory).toHaveBeenCalledTimes(1);
    expect(updateDepthErrors()).toEqual([]);
  });

  it.each([
    {
      state: "no focused navigation surface",
      opens: null,
      toasts: ["Can't preview this file here"],
    },
    {
      state: "a surface that declines the file",
      opens: false,
      toasts: ["Can't preview this file here"],
    },
    { state: "a surface that opens the file", opens: true, toasts: [] },
  ])("handles a file row with $state", async ({ opens, toasts }) => {
    const openFilePreview = vi.fn(() => opens === true);
    navigation.surface =
      opens === null
        ? null
        : { openFilePreview, panel: UNAVAILABLE_APP_PANEL_CONTROLLER };
    vi.mocked(sdk.projects.directory).mockResolvedValue({
      entries: [{ kind: "file", name: "notes.md", path: "notes.md" }],
      truncated: false,
    });
    renderRegion([makeProject(THIS_HOST_ID)]);

    fireEvent.click(await screen.findByText("Alpha"));
    fireEvent.click(await screen.findByText("notes.md"));

    expect(openFilePreview).toHaveBeenCalledTimes(opens === null ? 0 : 1);
    expect(
      vi.mocked(appToast.error).mock.calls.map(([title]) => title),
    ).toEqual(toasts);
  });

  it("marks the active file of the focused surface and follows tab changes", async () => {
    const panel = createAppPanelController(() => ({
      activeTabId: null,
      close: () => undefined,
      destinations: [],
    }));
    navigation.surface = { openFilePreview: () => true, panel };
    vi.mocked(sdk.projects.directory).mockResolvedValue({
      entries: [
        { kind: "file", name: "notes.md", path: "notes.md" },
        { kind: "file", name: "other.md", path: "other.md" },
      ],
      truncated: false,
    });
    const publishFile = (path: string | null) =>
      panel.publishTabs({
        open: true,
        selectedKey: path === null ? null : "tab",
        entries:
          path === null
            ? []
            : [
                {
                  key: "tab",
                  title: path,
                  status: null,
                  closable: true,
                  detail: { kind: "file", path },
                  icon: null,
                  select: () => undefined,
                  close: () => undefined,
                },
              ],
      });
    publishFile("/repo/alpha/notes.md");
    renderRegion([makeProject(THIS_HOST_ID)]);
    fireEvent.click(await screen.findByText("Alpha"));
    const row = (name: string) =>
      screen.getByText(name).closest('[role="treeitem"]');

    await screen.findByText("notes.md");
    expect(row("notes.md")?.getAttribute("aria-current")).toBe("true");
    expect(row("other.md")?.getAttribute("aria-current")).toBeNull();

    act(() => publishFile("/repo/alpha/other.md"));
    expect(row("notes.md")?.getAttribute("aria-current")).toBeNull();
    expect(row("other.md")?.getAttribute("aria-current")).toBe("true");

    act(() => publishFile(null));
    expect(row("other.md")?.getAttribute("aria-current")).toBeNull();
  });
});
