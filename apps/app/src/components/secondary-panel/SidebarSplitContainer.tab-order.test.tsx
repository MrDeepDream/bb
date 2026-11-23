// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { useMemo, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveSecondaryPanelTab } from "@bb/client-core";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useFixedPanelTabsState } from "@/lib/fixed-panel-tabs";
import {
  SidebarSplitContainer,
  type SidebarSplitPaneRenderArgs,
  type SidebarSplitTabDescriptor,
} from "./SidebarSplitContainer";
import {
  resetRecentlyClosedPanelTabsForTest,
  useThreadFileTabs,
} from "./useThreadFileTabs";

vi.mock("@/hooks/queries/thread-tabs-query", () => ({
  useThreadTabs: () => ({ data: undefined }),
}));

vi.mock("@/lib/thread-tabs-sync", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/thread-tabs-sync")>();
  return {
    ...actual,
    hasPendingThreadTabsWrite: () => false,
    scheduleLocalThreadTabsMigration: vi.fn(),
    scheduleThreadTabsPersistence: vi.fn(),
  };
});

const PANEL_STATE_ID = "sidebar-tab-order";
let nextPanelInstance = 0;
const FIXED_TAB: SidebarSplitTabDescriptor = {
  id: "fixed-info",
  label: "Info",
  restoresPlacementAfterRemoval: true,
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

interface TabOrderHandle {
  panel: ReturnType<typeof useThreadFileTabs> | null;
  panes: Map<string, SidebarSplitPaneRenderArgs>;
}

function createHandle(): TabOrderHandle {
  return { panel: null, panes: new Map() };
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </SidebarProvider>
    </QueryClientProvider>
  );
}

function TabOrderHarness({
  handle,
  panelStateId,
}: {
  handle: TabOrderHandle;
  panelStateId: string;
}) {
  const panel = useThreadFileTabs({
    panelStateId,
    syncThreadId: null,
    environmentId: "env_1",
    storageFiles: undefined,
    terminalSessions: undefined,
  });
  handle.panel = panel;
  const state = useFixedPanelTabsState(panelStateId, null);
  const openTabIds = panel.orderedSecondaryFileTabs
    .map((tab) => tab.id)
    .join("\n");
  const tabs = useMemo(
    () => [
      FIXED_TAB,
      ...(openTabIds === "" ? [] : openTabIds.split("\n")).map((id) => ({
        id,
        label: id,
        restoresPlacementAfterRemoval: true,
      })),
    ],
    [openTabIds],
  );
  return (
    <SidebarSplitContainer
      isTabListReady
      activeTabId={getActiveSecondaryPanelTab(state)?.id ?? FIXED_TAB.id}
      fixedTabIds={[FIXED_TAB.id]}
      isFullScreen={false}
      onActivateTab={panel.activateTab}
      onGlobalTabReorder={panel.reorderTab}
      onToggleFullScreen={vi.fn()}
      panelStateId={panelStateId}
      renderPane={(args) => {
        handle.panes.set(args.paneId, args);
        return (
          <div
            data-tab-order={args.group.tabIds
              .filter((id) => id !== FIXED_TAB.id)
              .join(",")}
          />
        );
      }}
      tabs={tabs}
    />
  );
}

function renderHarness(): TabOrderHandle {
  const handle = createHandle();
  render(
    <Providers>
      <TabOrderHarness
        handle={handle}
        panelStateId={`${PANEL_STATE_ID}-${nextPanelInstance++}`}
      />
    </Providers>,
  );
  return handle;
}

function requirePanel(handle: TabOrderHandle) {
  if (handle.panel === null) throw new Error("Harness did not render");
  return handle.panel;
}

function openFile(handle: TabOrderHandle, name: string): string {
  let tabId = "";
  act(() => {
    tabId =
      requirePanel(handle).openTab({
        kind: "workspace-file-preview",
        tab: {
          lineRange: null,
          path: name,
          source: { kind: "working-tree" },
          statusLabel: null,
        },
      })?.id ?? "";
  });
  return tabId;
}

function closeAll(handle: TabOrderHandle): void {
  const panel = requirePanel(handle);
  act(() => {
    for (const tab of panel.orderedSecondaryFileTabs) {
      panel.closeTabNow(tab.id);
    }
  });
}

function paneOrders(): string[][] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-tab-order]"),
    (pane) =>
      (pane.dataset.tabOrder ?? "")
        .split(",")
        .filter(Boolean)
        .map((tabId) => tabId.split(":")[1] ?? tabId),
  );
}

function paneWith(handle: TabOrderHandle, tabId: string) {
  const pane = Array.from(handle.panes.values()).find((candidate) =>
    candidate.group.tabIds.includes(tabId),
  );
  if (pane === undefined) throw new Error(`No pane holds ${tabId}`);
  return pane;
}

const FILE_NAMES = Array.from(
  { length: 30 },
  (_, index) => `f${String(index + 1).padStart(2, "0")}.ts`,
);

describe("SidebarSplitContainer tab order", () => {
  afterEach(() => {
    cleanup();
    queryClient.clear();
    window.localStorage.clear();
    resetRecentlyClosedPanelTabsForTest();
  });

  it("keeps click order when files are opened after Close All of a reordered strip", () => {
    const handle = renderHarness();
    const ids = new Map(
      FILE_NAMES.map((name) => [name, openFile(handle, name)]),
    );
    expect(paneOrders()).toEqual([FILE_NAMES]);

    const reorder = (activeName: string, overName: string) => {
      const activeTabId = ids.get(activeName) ?? "";
      const overTabId = ids.get(overName) ?? "";
      act(() =>
        paneWith(handle, activeTabId).onReorderTab({ activeTabId, overTabId }),
      );
    };
    reorder("f17.ts", "f13.ts");
    reorder("f18.ts", "f01.ts");
    expect(paneOrders()[0]?.slice(0, 2)).toEqual(["f18.ts", "f01.ts"]);

    closeAll(handle);
    expect(paneOrders()).toEqual([[]]);
    for (const name of FILE_NAMES) openFile(handle, name);

    expect(paneOrders()).toEqual([FILE_NAMES]);
  });

  it("appends a closed file that is opened again from the tree", () => {
    const handle = renderHarness();
    openFile(handle, "a.ts");
    const b = openFile(handle, "b.ts");
    openFile(handle, "c.ts");

    act(() => requirePanel(handle).closeTabNow(b));
    openFile(handle, "b.ts");

    expect(paneOrders()).toEqual([["a.ts", "c.ts", "b.ts"]]);
  });

  it("opens a closed file in the focused pane instead of its old pane", () => {
    const handle = renderHarness();
    const a = openFile(handle, "a.ts");
    openFile(handle, "b.ts");
    const c = openFile(handle, "c.ts");
    act(() => paneWith(handle, c).onMoveActiveTabToSide?.("right"));
    openFile(handle, "d.ts");
    expect(paneOrders()).toEqual([
      ["a.ts", "b.ts"],
      ["c.ts", "d.ts"],
    ]);

    act(() => requirePanel(handle).closeTabNow(c));
    act(() => paneWith(handle, a).onFocusPane());
    openFile(handle, "c.ts");

    expect(paneOrders()).toEqual([["a.ts", "b.ts", "c.ts"], ["d.ts"]]);
  });

  it("returns a tab to its pane and slot through Reopen Closed Tab", () => {
    const handle = renderHarness();
    const a = openFile(handle, "a.ts");
    openFile(handle, "b.ts");
    const c = openFile(handle, "c.ts");
    act(() => paneWith(handle, c).onMoveActiveTabToSide?.("right"));
    openFile(handle, "d.ts");

    act(() => requirePanel(handle).closeTabNow(c));
    act(() => paneWith(handle, a).onFocusPane());
    act(() => {
      requirePanel(handle).reopenClosedTab();
    });

    expect(paneOrders()).toEqual([
      ["a.ts", "b.ts"],
      ["c.ts", "d.ts"],
    ]);
  });

  it("restores the slot of a tab that disappears without being closed", () => {
    const panes = new Map<string, SidebarSplitPaneRenderArgs>();
    const descriptor = (id: string): SidebarSplitTabDescriptor => ({
      id,
      label: id,
      restoresPlacementAfterRemoval: true,
    });
    const container = (ids: readonly string[]) => (
      <Providers>
        <SidebarSplitContainer
          isTabListReady
          activeTabId="a"
          isFullScreen={false}
          onActivateTab={vi.fn()}
          onGlobalTabReorder={vi.fn()}
          onToggleFullScreen={vi.fn()}
          panelStateId={`${PANEL_STATE_ID}-transient`}
          renderPane={(args) => {
            panes.set(args.paneId, args);
            return <div data-tab-order={args.group.tabIds.join(",")} />;
          }}
          tabs={ids.map(descriptor)}
        />
      </Providers>
    );
    const view = render(container(["a", "b", "c"]));
    const [pane] = panes.values();
    act(() => pane?.onReorderTab({ activeTabId: "c", overTabId: "a" }));
    expect(paneOrders()).toEqual([["c", "a", "b"]]);

    view.rerender(container(["a", "c"]));
    view.rerender(container(["a", "b", "c"]));

    expect(paneOrders()).toEqual([["c", "a", "b"]]);
  });
});
