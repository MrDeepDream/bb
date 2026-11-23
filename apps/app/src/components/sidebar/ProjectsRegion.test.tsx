// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    navigation.surface = opens === null ? null : { openFilePreview };
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
});
