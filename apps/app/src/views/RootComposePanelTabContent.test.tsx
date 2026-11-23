// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";
import { createHostFilePreviewFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { RootComposePanelTabContent } from "./RootComposePanelTabContent";

const PREVIEW_PATH = "/tmp/notes.md";
const ENVIRONMENT_ID = "env_root";
const ENVIRONMENT_HOST_ID = "host_environment";
const TAB_HOST_ID = "host_tab";

vi.mock("@/hooks/queries/environment-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/environment-queries")
  >()),
  useEnvironment: (environmentId: string | null) => ({
    data:
      environmentId === "env_root"
        ? { hostId: "host_environment", path: "/workspace" }
        : undefined,
  }),
}));

vi.mock("@/hooks/queries/thread-panel-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/thread-panel-queries")
  >()),
  useThreadStorageLocation: () => ({ data: undefined }),
}));

vi.mock("@/hooks/useLiveFileOpenTargets", () => ({
  useLiveFileOpenTargets: (root: object | null) => ({
    canOpenExternally: root !== null,
  }),
}));

vi.mock("@/components/commands/AppCommandProvider", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/commands/AppCommandProvider")
  >()),
  useAppCommandHandler: () => undefined,
}));

vi.mock(
  "@/components/secondary-panel/lazySecondaryPanelComponents",
  async (importOriginal) => {
    function OpenExternallyButton({
      onOpenInEditor,
    }: {
      onOpenInEditor?: () => void;
    }) {
      return (
        <button
          disabled={onOpenInEditor === undefined}
          onClick={onOpenInEditor}
          type="button"
        >
          Open externally
        </button>
      );
    }
    return {
      ...(await importOriginal<
        typeof import("@/components/secondary-panel/lazySecondaryPanelComponents")
      >()),
      LazyFilePreview: OpenExternallyButton,
      LazyHostFilePreviewTabContent: OpenExternallyButton,
      LazyHostScopedFilePreviewTabContent: OpenExternallyButton,
    };
  },
);

function renderHostFilePreview({
  rootPanelEnvironmentId,
  tabHostId,
}: {
  rootPanelEnvironmentId: string | null;
  tabHostId: string | null;
}) {
  const openFileExternally = vi.fn(() => true);
  const noop = () => undefined;
  const props: ComponentProps<typeof RootComposePanelTabContent> = {
    activeTabId: null,
    autoFocusTerminalId: null,
    canCreateTerminal: false,
    currentProjectId: "proj_root",
    isPanelOpen: true,
    isPanelPersistedOpen: true,
    isProjectless: false,
    onActivateTab: noop,
    onAutoFocusNewTabHandled: noop,
    onAutoFocusTerminalHandled: noop,
    onCloseTerminal: noop,
    onOpenBrowser: null,
    onOpenPanelLink: () => false,
    onRetryTerminalStart: noop,
    onSelectFileSearchResult: noop,
    onSelectionAddToChat: noop,
    onStartTerminal: noop,
    pane: { isFocused: true, onFocusPane: noop },
    pluginActions: [],
    primaryHostId: null,
    projectSources: [],
    projects: undefined,
    rootPanelEnvironmentId,
    rootPanelThreadId: rootPanelEnvironmentId === null ? null : "thr_root",
    rootProjectHostId: null,
    shouldAutoFocusNewTab: false,
    tab: createHostFilePreviewFixedPanelTab({
      environmentId: null,
      hostId: tabHostId,
      tab: { lineRange: null, path: PREVIEW_PATH },
      threadId: null,
    }),
    terminalTarget: null,
  };
  render(
    <AppNavigationHostProvider capabilities={{ openFileExternally }}>
      <RootComposePanelTabContent {...props} />
    </AppNavigationHostProvider>,
  );
  return {
    button: screen.getByRole<HTMLButtonElement>("button", {
      name: "Open externally",
    }),
    openFileExternally,
  };
}

afterEach(cleanup);

describe("RootComposePanelTabContent host file preview", () => {
  it.each([
    {
      name: "uses the tab host when no environment exists",
      rootPanelEnvironmentId: null,
      tabHostId: TAB_HOST_ID,
      expectedHostId: TAB_HOST_ID,
    },
    {
      name: "prefers the tab host over a different environment host",
      rootPanelEnvironmentId: ENVIRONMENT_ID,
      tabHostId: TAB_HOST_ID,
      expectedHostId: TAB_HOST_ID,
    },
    {
      name: "uses the environment host for a tab without its own host",
      rootPanelEnvironmentId: ENVIRONMENT_ID,
      tabHostId: null,
      expectedHostId: ENVIRONMENT_HOST_ID,
    },
  ])("$name", ({ expectedHostId, rootPanelEnvironmentId, tabHostId }) => {
    const { button, openFileExternally } = renderHostFilePreview({
      rootPanelEnvironmentId,
      tabHostId,
    });

    fireEvent.click(button);

    expect(openFileExternally).toHaveBeenCalledExactlyOnceWith({
      location: null,
      target: { kind: "host", hostId: expectedHostId, path: PREVIEW_PATH },
    });
  });

  it("offers no external open when neither the tab nor an environment has a host", () => {
    const { button } = renderHostFilePreview({
      rootPanelEnvironmentId: null,
      tabHostId: null,
    });

    expect(button.disabled).toBe(true);
  });
});
