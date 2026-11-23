// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, expect, it, vi } from "vitest";
import { SecondaryPanelTabStrip } from "./SecondaryPanelTabStrip";
import { SidebarSplitContainer } from "./SidebarSplitContainer";
import {
  serializeSidebarSplitState,
  sidebarPaneNode,
  sidebarSplitStorageKey,
  type SidebarSplitState,
} from "./sidebarSplitLayout";

const descriptors = ["alpha.ts", "beta.ts"].map((label) => ({
  id: label,
  label,
  restoresPlacementAfterRemoval: true,
}));

const TWO_GROUP_PANEL_ID = "tab-gestures-two-groups";
const PANE_WIDTH = 300;
const TAB_WIDTH = 100;
const TWO_GROUP_STATE: SidebarSplitState = {
  version: 1,
  groups: {
    "group-left": {
      id: "group-left",
      tabIds: ["left-a.ts", "left-b.ts"],
      activeTabId: "left-a.ts",
    },
    "group-right": {
      id: "group-right",
      tabIds: ["f31.ts", "f32.ts"],
      activeTabId: "f32.ts",
    },
  },
  layout: {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        sidebarPaneNode("pane-primary", "group-left"),
        sidebarPaneNode("pane-1", "group-right"),
      ],
    },
    focusedPaneId: "pane-1",
  },
  maximizedPaneId: null,
};

function renderTwoGroups() {
  const onReorder = vi.fn();
  const tabIds = Object.values(TWO_GROUP_STATE.groups).flatMap(
    (group) => group.tabIds,
  );
  window.localStorage.setItem(
    sidebarSplitStorageKey(TWO_GROUP_PANEL_ID),
    serializeSidebarSplitState(TWO_GROUP_STATE),
  );
  render(
    <TooltipProvider>
      <aside>
        <SidebarSplitContainer
          isTabListReady
          activeTabId="f32.ts"
          isFullScreen={false}
          onActivateTab={() => {}}
          onGlobalTabReorder={onReorder}
          onToggleFullScreen={() => {}}
          panelStateId={TWO_GROUP_PANEL_ID}
          tabs={tabIds.map((id) => ({
            id,
            label: id,
            restoresPlacementAfterRemoval: true,
          }))}
          renderPane={({ group, onBeginTabDrag, onReorderTab, paneId }) => (
            <div
              data-testid="thread-secondary-panel-top-chrome"
              data-sidebar-split-tab-group={paneId}
              data-group-tabs={group.tabIds.join(",")}
            >
              <SecondaryPanelTabStrip
                activeTabId={group.activeTabId}
                tabs={group.tabIds.map((id) => ({
                  label: id,
                  leadingVisual: null,
                  statusLabel: null,
                  onClose: () => {},
                  onSelect: () => {},
                  renderContent: () => null,
                  tab: {
                    id,
                    kind: "host-file-preview" as const,
                    environmentId: null,
                    hostId: null,
                    lineRange: null,
                    path: id,
                    threadId: null,
                  },
                }))}
                onBeginTabDrag={onBeginTabDrag}
                onReorderTab={onReorderTab}
                usesDesktopChrome={false}
                isPanelOpen
              />
            </div>
          )}
        />
      </aside>
    </TooltipProvider>,
  );
  const stripFor = (paneId: string) =>
    document.querySelector<HTMLElement>(
      `[data-sidebar-split-tab-group="${paneId}"]`,
    );
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: (x: number) => {
      const strip = stripFor(x < PANE_WIDTH ? "pane-primary" : "pane-1");
      return strip === null ? [] : [strip];
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.tagName === "ASIDE") {
        return new DOMRect(0, 0, PANE_WIDTH * 2, 400);
      }
      const pane = this.closest<HTMLElement>("[data-split-pane-id]");
      const paneLeft = pane?.dataset.splitPaneId === "pane-1" ? PANE_WIDTH : 0;
      if (this.dataset.panelTabId !== undefined) {
        const index = [
          ...(pane?.querySelectorAll("[data-panel-tab-id]") ?? []),
        ].indexOf(this);
        return new DOMRect(paneLeft + index * TAB_WIDTH, 0, TAB_WIDTH, 40);
      }
      const isChrome =
        this.dataset.testid === "thread-secondary-panel-top-chrome";
      return new DOMRect(paneLeft, 0, PANE_WIDTH, isChrome ? 40 : 400);
    },
  );
  return { onReorder };
}

function groupTabs(paneId: string): string[] {
  return (
    document
      .querySelector<HTMLElement>(`[data-sidebar-split-tab-group="${paneId}"]`)
      ?.dataset.groupTabs?.split(",") ?? []
  );
}

function dragAlongStrip(target: HTMLElement, path: readonly number[]) {
  const [startX = 0] = path;
  const start = { button: 0, clientX: startX, clientY: 20 };
  fireEvent(target, new MouseEvent("pointerdown", { bubbles: true, ...start }));
  fireEvent.mouseDown(target, start);
  for (const clientX of path.slice(1)) {
    const point = { clientX, clientY: 20 };
    fireEvent(window, new MouseEvent("pointermove", point));
    fireEvent.mouseMove(document, point);
  }
}

function releaseDrag(target: HTMLElement) {
  fireEvent(window, new MouseEvent("pointerup"));
  fireEvent.mouseUp(document);
  fireEvent.click(target);
}

afterEach(() => {
  fireEvent.click(document.body);
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementsFromPoint");
});

function renderTabs() {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const onReorder = vi.fn();

  render(
    <TooltipProvider>
      <aside>
        <SidebarSplitContainer
          isTabListReady
          activeTabId="alpha.ts"
          isFullScreen={false}
          onActivateTab={() => {}}
          onGlobalTabReorder={onReorder}
          onToggleFullScreen={() => {}}
          panelStateId="tab-gestures"
          tabs={descriptors}
          renderPane={({ group, onBeginTabDrag, onReorderTab }) => (
            <div data-testid="thread-secondary-panel-top-chrome">
              <SecondaryPanelTabStrip
                activeTabId={group.activeTabId}
                tabs={group.tabIds.map((id) => ({
                  label: id,
                  leadingVisual: null,
                  statusLabel: null,
                  onClose: () => onClose(id),
                  onSelect: () => onSelect(id),
                  renderContent: () => null,
                  tab: {
                    id,
                    kind: "host-file-preview" as const,
                    environmentId: null,
                    hostId: null,
                    lineRange: null,
                    path: id,
                    threadId: null,
                  },
                }))}
                onBeginTabDrag={onBeginTabDrag}
                onReorderTab={onReorderTab}
                usesDesktopChrome={false}
                isPanelOpen
              />
            </div>
          )}
        />
      </aside>
    </TooltipProvider>,
  );
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => [],
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const isChrome =
        this.dataset.testid === "thread-secondary-panel-top-chrome";
      return new DOMRect(0, 0, 600, isChrome ? 40 : 400);
    },
  );
  return { onClose, onSelect, onReorder };
}

function pressAndRelease(target: HTMLElement, deltaY: number) {
  const start = { button: 0, clientX: 100, clientY: 20 };
  const end = { clientX: 100, clientY: 20 + deltaY };
  fireEvent(target, new MouseEvent("pointerdown", { bubbles: true, ...start }));
  fireEvent.mouseDown(target, start);
  fireEvent(window, new MouseEvent("pointermove", end));
  fireEvent.mouseMove(document, end);
  fireEvent(window, new MouseEvent("pointerup"));
  fireEvent.mouseUp(document);
  fireEvent.click(target);
}

it.each([5, 8])(
  "selects a tab clicked with %spx of jitter without reordering or splitting",
  (deltaY) => {
    const { onSelect, onReorder } = renderTabs();
    pressAndRelease(screen.getByRole("tab", { name: "beta.ts" }), deltaY);
    expect(onSelect).toHaveBeenCalledWith("beta.ts");
    expect(onReorder).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
  },
);

it("closes a tab whose close press moves vertically without splitting", () => {
  const { onClose } = renderTabs();
  pressAndRelease(screen.getByRole("button", { name: "Close beta.ts" }), 16);
  expect(onClose).toHaveBeenCalledWith("beta.ts");
  expect(screen.queryAllByRole("separator")).toHaveLength(0);
});

it("splits a tab dragged 16px vertically", () => {
  const { onSelect, onClose } = renderTabs();
  pressAndRelease(screen.getByRole("tab", { name: "beta.ts" }), 16);
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it.each([
  { dropX: 10, expected: ["f32.ts", "left-a.ts", "left-b.ts"] },
  { dropX: 120, expected: ["left-a.ts", "f32.ts", "left-b.ts"] },
  { dropX: 280, expected: ["left-a.ts", "left-b.ts", "f32.ts"] },
])(
  "moves a tab dropped on another group's strip at x=$dropX",
  ({ dropX, expected }) => {
    renderTwoGroups();
    const tab = screen.getByRole("tab", { name: "f32.ts" });
    dragAlongStrip(tab, [450, 380, 290, dropX]);
    releaseDrag(tab);
    expect(groupTabs("pane-primary")).toEqual(expected);
    expect(groupTabs("pane-1")).toEqual(["f31.ts"]);
  },
);

it("keeps a horizontal drag inside one group as a strip reorder", () => {
  renderTwoGroups();
  const tab = screen.getByRole("tab", { name: "f32.ts" });
  dragAlongStrip(tab, [450, 400, 340]);
  expect(document.querySelector("[data-split-drag-ghost]")).toBeNull();
  releaseDrag(tab);
  expect(groupTabs("pane-primary")).toEqual(["left-a.ts", "left-b.ts"]);
});

it("reorders within the group when a drag leaves the pane and returns", () => {
  const { onReorder } = renderTwoGroups();
  const tab = screen.getByRole("tab", { name: "f31.ts" });
  dragAlongStrip(tab, [350, 200, 480]);
  releaseDrag(tab);
  expect(groupTabs("pane-1")).toEqual(["f32.ts", "f31.ts"]);
  expect(groupTabs("pane-primary")).toEqual(["left-a.ts", "left-b.ts"]);
  expect(onReorder).toHaveBeenCalledWith({
    activeTabId: "f31.ts",
    overTabId: "f32.ts",
  });
});
