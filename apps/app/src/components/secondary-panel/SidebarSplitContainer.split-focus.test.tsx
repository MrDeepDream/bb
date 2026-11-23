// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { StrictMode, useEffect, useRef, useState } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  SidebarSplitContainer,
  type SidebarPendingTabMove,
  type SidebarSplitPaneRenderArgs,
  type SidebarSplitTabDescriptor,
} from "./SidebarSplitContainer";
import {
  createSidebarSplitState,
  moveSidebarTab,
  serializeSidebarSplitState,
  sidebarSplitStorageKey,
} from "./sidebarSplitLayout";

const PANEL_STATE_ID = "sidebar-split-focus";
const SPLIT_FOCUS_WAIT_LIMIT_MS = 5000;
const BASE_TABS: readonly SidebarSplitTabDescriptor[] = [
  { id: "file", label: "file.ts", restoresPlacementAfterRemoval: true },
  { id: "other", label: "other.ts", restoresPlacementAfterRemoval: true },
];
const VIEW_TAB: SidebarSplitTabDescriptor = {
  id: "file-view-2",
  label: "file.ts",
  restoresPlacementAfterRemoval: true,
};

interface SplitFocusHandle {
  mountEditors: () => void;
  panes: Map<string, SidebarSplitPaneRenderArgs>;
  remountEditors: () => void;
  split: (side: "right" | "bottom") => void;
}

function ImperativeEditor({ testId }: { testId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = document.createElement("div");
    input.setAttribute("role", "textbox");
    input.setAttribute("aria-multiline", "true");
    input.setAttribute("data-testid", testId);
    input.tabIndex = 0;
    hostRef.current?.append(input);
    return () => input.remove();
  }, [testId]);
  return <div ref={hostRef} />;
}

function SplitFocusHarness({
  editorsMounted = false,
  handle,
  imperativeEditors = false,
}: {
  editorsMounted?: boolean;
  handle: SplitFocusHandle;
  imperativeEditors?: boolean;
}) {
  const [tabs, setTabs] = useState(BASE_TABS);
  const [activeTabId, setActiveTabId] = useState("file");
  const [pending, setPending] = useState<SidebarPendingTabMove | null>(null);
  const [isEditorMounted, setIsEditorMounted] = useState(editorsMounted);
  const [editorGeneration, setEditorGeneration] = useState(0);
  handle.mountEditors = () => setIsEditorMounted(true);
  handle.remountEditors = () => setEditorGeneration((value) => value + 1);
  handle.split = (side) => {
    setTabs([...BASE_TABS, VIEW_TAB]);
    setActiveTabId(VIEW_TAB.id);
    setPending({ anchorTabId: "file", tabId: VIEW_TAB.id, side });
  };
  return (
    <SidebarProvider>
      <TooltipProvider>
        <button type="button" data-testid="outside">
          Outside
        </button>
        <SidebarSplitContainer
          isTabListReady
          activeTabId={activeTabId}
          isFullScreen={false}
          onActivateTab={setActiveTabId}
          onGlobalTabReorder={vi.fn()}
          onPendingTabMoveDone={() => setPending(null)}
          onToggleFullScreen={vi.fn()}
          panelStateId={PANEL_STATE_ID}
          pendingTabMove={pending}
          renderPane={(args) => {
            handle.panes.set(args.paneId, args);
            const tabId = args.group.activeTabId;
            return (
              <div role="tabpanel">
                <input aria-label={`Find in ${tabId}`} />
                {imperativeEditors ? (
                  <ImperativeEditor testId={`editor-${tabId}`} />
                ) : null}
                {isEditorMounted ? (
                  <div key={editorGeneration}>
                    <textarea aria-hidden="true" tabIndex={-1} readOnly />
                    <div
                      role="textbox"
                      aria-multiline="true"
                      tabIndex={0}
                      data-testid={`editor-${tabId}`}
                    />
                  </div>
                ) : null}
              </div>
            );
          }}
          tabs={tabs}
        />
      </TooltipProvider>
    </SidebarProvider>
  );
}

function renderHarness(editorsMounted = false) {
  const handle: SplitFocusHandle = {
    mountEditors: () => {},
    panes: new Map(),
    remountEditors: () => {},
    split: () => {},
  };
  const view = render(
    <SplitFocusHarness editorsMounted={editorsMounted} handle={handle} />,
  );
  return { handle, view };
}

async function flushObservers(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function activeTestId(): string | null {
  return document.activeElement?.getAttribute("data-testid") ?? null;
}

describe("SidebarSplitContainer split focus", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each(["right", "bottom"] as const)(
    "moves keyboard focus into the editor that mounts after a split %s",
    async (side) => {
      const { handle } = renderHarness();

      act(() => handle.split(side));
      await flushObservers();
      expect(document.activeElement).toBe(document.body);

      act(() => handle.mountEditors());
      await flushObservers();

      expect(activeTestId()).toBe(`editor-${VIEW_TAB.id}`);
    },
  );

  it("focuses an editor that is already mounted when the split commits", async () => {
    const { handle } = renderHarness(true);

    act(() => handle.split("right"));
    await flushObservers();

    expect(activeTestId()).toBe(`editor-${VIEW_TAB.id}`);
  });

  it("keeps focus when StrictMode replays the new editor's effects", async () => {
    const handle: SplitFocusHandle = {
      mountEditors: () => {},
      panes: new Map(),
      remountEditors: () => {},
      split: () => {},
    };
    render(
      <StrictMode>
        <SplitFocusHarness handle={handle} imperativeEditors />
      </StrictMode>,
    );

    act(() => handle.split("right"));
    await flushObservers();

    expect(activeTestId()).toBe(`editor-${VIEW_TAB.id}`);
    expect(document.activeElement?.isConnected).toBe(true);
  });

  it("focuses the replacement when the tab's editor remounts", async () => {
    const { handle, view } = renderHarness(true);
    act(() => handle.split("right"));
    await flushObservers();
    const first = view.getByTestId(`editor-${VIEW_TAB.id}`);
    expect(document.activeElement).toBe(first);

    act(() => handle.remountEditors());
    await flushObservers();

    const replacement = view.getByTestId(`editor-${VIEW_TAB.id}`);
    expect(replacement).not.toBe(first);
    expect(document.activeElement).toBe(replacement);
  });

  it("releases the pending focus when the container unmounts", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { handle, view } = renderHarness();
    act(() => handle.split("right"));
    await flushObservers();
    disconnect.mockClear();

    view.unmount();

    expect(disconnect).toHaveBeenCalledTimes(1);
    disconnect.mockRestore();
  });

  it("keeps focus where the user moved it before the editor mounted", async () => {
    const { handle, view } = renderHarness();
    act(() => handle.split("right"));
    await flushObservers();

    const outside = view.getByTestId("outside");
    act(() => outside.focus());
    act(() => handle.mountEditors());
    await flushObservers();

    expect(document.activeElement).toBe(outside);
  });

  it("keeps the pending focus when the closing menu takes focus on hover", async () => {
    const { handle } = renderHarness();
    act(() => handle.split("right"));
    await flushObservers();

    const menu = document.body.appendChild(document.createElement("div"));
    onTestFinished(() => menu.remove());
    menu.setAttribute("role", "menu");
    const item = menu.appendChild(document.createElement("button"));
    act(() => item.focus());
    act(() => handle.mountEditors());
    await flushObservers();

    expect(activeTestId()).toBe(`editor-${VIEW_TAB.id}`);
  });

  it("drops the pending focus when the user presses the pointer first", async () => {
    const { handle, view } = renderHarness();
    act(() => handle.split("right"));
    await flushObservers();

    fireEvent.pointerDown(view.getByTestId("outside"));
    act(() => handle.mountEditors());
    await flushObservers();

    expect(document.activeElement).toBe(document.body);
  });

  it("stops waiting for an editor after the wait limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { handle } = renderHarness();
    act(() => handle.split("right"));
    await flushObservers();

    act(() => {
      vi.advanceTimersByTime(SPLIT_FOCUS_WAIT_LIMIT_MS + 1);
    });
    act(() => handle.mountEditors());
    await flushObservers();

    expect(document.activeElement).toBe(document.body);
  });

  it("does not move focus when a saved split is restored", async () => {
    const initial = createSidebarSplitState(
      BASE_TABS.map((tab) => tab.id),
      "file",
    );
    window.localStorage.setItem(
      sidebarSplitStorageKey(PANEL_STATE_ID),
      serializeSidebarSplitState(
        moveSidebarTab(
          initial,
          initial.layout.focusedPaneId,
          "other",
          { paneId: initial.layout.focusedPaneId, zone: "right" },
          { groupId: "group-other" },
        ),
      ),
    );
    const { handle } = renderHarness();
    expect(handle.panes.size).toBe(2);

    act(() => handle.mountEditors());
    await flushObservers();

    expect(document.activeElement).toBe(document.body);
  });

  it("does not move focus for a split made by the arrangement control", async () => {
    const { handle } = renderHarness();
    const [pane] = handle.panes.values();

    act(() => pane?.onMoveActiveTabToSide?.("right"));
    act(() => handle.mountEditors());
    await flushObservers();

    expect(handle.panes.size).toBe(2);
    expect(document.activeElement).toBe(document.body);
  });
});
