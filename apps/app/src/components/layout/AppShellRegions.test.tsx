// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createStore, Provider, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalFixedPanelTab,
  createThreadInfoFixedPanelTab,
  EMPTY_FIXED_PANEL_TABS_STATE,
} from "@bb/client-core";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { usePanelTerminals } from "@/components/secondary-panel/usePanelTerminals";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import {
  bottomRegionOpenAtom,
  bottomTerminalIdAtomFamily,
  resolveBottomTerminalTab,
  resolveContentShellHasPanelRoom,
} from "@/lib/app-shell-regions";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import {
  resetFixedPanelTabsStateForTest,
  useFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import type { FixedPanelTabsState } from "@/lib/fixed-panel-tabs-state";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  getActiveFixedSecondaryTab,
  isFixedSecondaryPanelOpen,
} from "@/views/thread-detail/threadSecondaryPanelSelection";
import {
  useThreadSecondaryPanelDrawerVisibility,
  useThreadSecondaryPanelVisibility,
} from "@/views/thread-detail/useThreadSecondaryPanelVisibility";
import {
  AppBottomRegionHost,
  AppTitleBar,
  BottomTerminalRegion,
} from "./AppShellRegions";

vi.mock("@/lib/bb-desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bb-desktop")>()),
  getBbDesktopInfo: vi.fn(() => null),
}));

const PANEL_STATE_ID = "shell-regions-panel";
const THREAD_INFO_TAB = createThreadInfoFixedPanelTab();
const TERMINAL_TAB = createTerminalFixedPanelTab({ terminalId: "term-1" });

function panelState(
  secondary: Partial<FixedPanelTabsState["secondary"]>,
): FixedPanelTabsState {
  return {
    ...EMPTY_FIXED_PANEL_TABS_STATE,
    secondary: {
      activeTabId: null,
      isOpen: false,
      tabs: [],
      ...secondary,
    },
  };
}

function Shell({
  children,
  compact,
  store,
}: {
  children: ReactNode;
  compact: boolean;
  store: ReturnType<typeof createStore>;
}) {
  return (
    <Provider store={store}>
      <CompactViewportOverrideProvider isCompactViewport={compact}>
        <TooltipProvider>
          <SidebarProvider width="328px">{children}</SidebarProvider>
        </TooltipProvider>
      </CompactViewportOverrideProvider>
    </Provider>
  );
}

function renderRegions({
  compact = false,
  store = createStore(),
}: {
  compact?: boolean;
  store?: ReturnType<typeof createStore>;
}) {
  render(
    <Shell compact={compact} store={store}>
      <div data-testid="content-shell">
        <main />
        <AppBottomRegionHost />
      </div>
      <AppTitleBar showsTerminalToggle />
    </Shell>,
  );
  return store;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetFixedPanelTabsStateForTest();
  vi.mocked(getBbDesktopInfo).mockReturnValue(null);
});

afterEach(cleanup);

describe("app shell regions", () => {
  it("renders the title bar on desktop with inert menu labels and real controls", () => {
    renderRegions({});

    const titleBar = screen.getByTestId("app-title-bar");
    const labels = screen.getByTestId("app-title-bar-menu-labels");
    expect(labels.getAttribute("aria-hidden")).toBe("true");
    expect(
      labels.querySelectorAll("button, a, [tabindex], [role^='menu']").length,
    ).toBe(0);
    for (const label of ["File", "Edit", "View", "Session", "Help"]) {
      expect(labels.textContent).toContain(label);
    }
    expect(titleBar.querySelector("[role='menubar']")).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Toggle sidebar/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Toggle terminal" }).tagName,
    ).toBe("BUTTON");
  });

  it("offers the native menu button only on Windows desktop", () => {
    const popupApplicationMenu = vi.fn();
    vi.mocked(getBbDesktopInfo).mockReturnValue({
      platform: "windows",
      popupApplicationMenu,
    } as unknown as ReturnType<typeof getBbDesktopInfo>);
    renderRegions({});

    act(() => screen.getByRole("button", { name: "Application menu" }).click());

    expect(popupApplicationMenu).toHaveBeenCalledWith({ x: 0, y: 0 });
  });

  it("renders neither title bar nor bottom region on compact viewports", () => {
    const store = createStore();
    store.set(bottomRegionOpenAtom, true);
    renderRegions({ compact: true, store });

    expect(screen.queryByTestId("app-title-bar")).toBeNull();
    expect(screen.queryByTestId("app-bottom-region")).toBeNull();
  });

  it("renders neither region in the framed macOS window", () => {
    vi.mocked(getBbDesktopInfo).mockReturnValue({
      platform: "macos",
    } as unknown as ReturnType<typeof getBbDesktopInfo>);
    const store = createStore();
    store.set(bottomRegionOpenAtom, true);
    renderRegions({ store });

    expect(screen.queryByTestId("app-title-bar")).toBeNull();
    expect(screen.queryByTestId("app-bottom-region")).toBeNull();
  });

  it("keeps the bottom region in flow directly after main", () => {
    const store = createStore();
    store.set(bottomRegionOpenAtom, true);
    renderRegions({ store });

    const region = screen.getByTestId("app-bottom-region");
    expect(region.previousElementSibling?.tagName).toBe("MAIN");
    expect(region.className).not.toMatch(/\b(fixed|absolute)\b/);
    expect(region.className).toContain("shrink-0");
  });

  it("does not start a terminal when the bottom region opens", () => {
    const start = vi.fn();
    const store = createStore();
    store.set(bottomRegionOpenAtom, true);
    render(
      <Shell compact={false} store={store}>
        <AppBottomRegionHost />
        <BottomTerminalRegion
          isFocused
          panelStateId={PANEL_STATE_ID}
          tabs={[]}
          terminals={{
            autoFocusTerminalId: null,
            canStart: true,
            close: vi.fn(),
            closeFocusedBottomTerminal: () => false,
            handleAutoFocusHandled: vi.fn(),
            open: () => false,
            retryStart: vi.fn(),
            select: vi.fn(),
            start,
          }}
        />
      </Shell>,
    );

    expect(start).not.toHaveBeenCalled();
    act(() => screen.getByRole("button", { name: "Start terminal" }).click());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("publishes panel room only across the 880px threshold", () => {
    expect(resolveContentShellHasPanelRoom(879)).toBe(false);
    expect(resolveContentShellHasPanelRoom(880)).toBe(true);
  });
});

describe("hidden terminal state", () => {
  it("resolves a stored terminal active tab to a visible tab without writing state", () => {
    const state = panelState({
      activeTabId: TERMINAL_TAB.id,
      isOpen: true,
      tabs: [THREAD_INFO_TAB, TERMINAL_TAB],
    });
    const snapshot = JSON.stringify(state);

    expect(
      getActiveFixedSecondaryTab({
        fixedPanelTabsState: state,
        hidesTerminals: true,
      })?.id,
    ).toBe(THREAD_INFO_TAB.id);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("treats a panel holding only hidden terminals as closed", () => {
    const state = panelState({
      activeTabId: TERMINAL_TAB.id,
      isOpen: true,
      tabs: [TERMINAL_TAB],
    });

    expect(
      isFixedSecondaryPanelOpen({
        fixedPanelTabsState: state,
        hidesTerminals: true,
      }),
    ).toBe(false);
    expect(
      isFixedSecondaryPanelOpen({
        fixedPanelTabsState: state,
        hidesTerminals: false,
      }),
    ).toBe(true);
  });

  it("falls back to the first terminal when the bottom id is gone", () => {
    expect(
      resolveBottomTerminalTab([THREAD_INFO_TAB, TERMINAL_TAB], "missing")?.id,
    ).toBe(TERMINAL_TAB.id);
  });
});

describe("desktop terminal selection", () => {
  function renderTerminals(store: ReturnType<typeof createStore>) {
    const { wrapper: QueryWrapper } = createQueryClientTestHarness();
    const reveal = vi.fn();
    const rendered = renderHook(
      () => ({
        bottomTerminalId: useAtomValue(
          bottomTerminalIdAtomFamily(PANEL_STATE_ID),
        ),
        isBottomOpen: useAtomValue(bottomRegionOpenAtom),
        state: useFixedPanelTabsState(PANEL_STATE_ID, null),
        terminals: usePanelTerminals({
          panelStateId: PANEL_STATE_ID,
          syncThreadId: null,
          createTarget: null,
          isFocused: true,
          acceptsSession: () => true,
          tabsCarryTarget: false,
          reveal,
          usesBottomRegion: true,
        }),
        update: useUpdateFixedPanelTabsState(PANEL_STATE_ID, null),
      }),
      {
        wrapper: ({ children }) => (
          <Provider store={store}>
            <QueryWrapper>{children}</QueryWrapper>
          </Provider>
        ),
      },
    );
    return { ...rendered, reveal };
  }

  it("targets the bottom region and leaves right panel state alone", () => {
    const store = createStore();
    const { result, reveal } = renderTerminals(store);
    act(() =>
      result.current.update((state) => ({
        ...state,
        secondary: {
          ...state.secondary,
          activeTabId: THREAD_INFO_TAB.id,
          isOpen: false,
          tabs: [THREAD_INFO_TAB],
        },
      })),
    );

    act(() => result.current.terminals.select("term-1"));

    expect(result.current.state.secondary.activeTabId).toBe(THREAD_INFO_TAB.id);
    expect(result.current.state.secondary.isOpen).toBe(false);
    expect(result.current.state.secondary.tabs.map((tab) => tab.id)).toContain(
      TERMINAL_TAB.id,
    );
    expect(result.current.bottomTerminalId).toBe("term-1");
    expect(result.current.isBottomOpen).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("does not close a hidden terminal on Ctrl+W when focus is elsewhere", () => {
    const store = createStore();
    const { result } = renderTerminals(store);
    act(() => result.current.terminals.select("term-1"));
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    let handled = true;
    act(() => {
      handled = result.current.terminals.closeFocusedBottomTerminal();
    });

    expect(handled).toBe(false);
    expect(result.current.state.secondary.tabs.map((tab) => tab.id)).toContain(
      TERMINAL_TAB.id,
    );
    outside.remove();
  });

  it("closes the terminal on Ctrl+W when focus is inside it", () => {
    const store = createStore();
    const { result } = renderTerminals(store);
    act(() => result.current.terminals.select("term-1"));
    const region = document.createElement("section");
    region.setAttribute("data-app-bottom-region", "");
    region.innerHTML =
      '<div data-bottom-terminal-id="term-1"><div data-app-terminal=""><textarea></textarea></div></div>';
    document.body.append(region);
    region.querySelector("textarea")?.focus();

    let handled = false;
    act(() => {
      handled = result.current.terminals.closeFocusedBottomTerminal();
    });

    expect(handled).toBe(true);
    expect(
      result.current.state.secondary.tabs.map((tab) => tab.id),
    ).not.toContain(TERMINAL_TAB.id);
    region.remove();
  });
});

describe("sidebar width and room rule storage", () => {
  it(
    "defaults to 328 and keeps a stored manual width",
    { timeout: 60_000 },
    async () => {
      vi.resetModules();
      const defaults = await import("./AppLayout");
      expect(createStore().get(defaults.sidebarWidthAtom)).toBe(328);

      vi.resetModules();
      localStorage.setItem("bb.sidebar.width", "400");
      sessionStorage.setItem("bb.sidebar.width", "400");
      const stored = await import("./AppLayout");
      expect(createStore().get(stored.sidebarWidthAtom)).toBe(400);
    },
  );

  it("hides the panel below the room threshold without touching stored state", () => {
    const closePersistedPanel = vi.fn();
    const openPersistedPanel = vi.fn();
    const togglePersistedPanel = vi.fn();
    const { result } = renderHook(() => {
      const drawerVisibility = useThreadSecondaryPanelDrawerVisibility({
        isCompactViewport: true,
        threadId: PANEL_STATE_ID,
      });
      return useThreadSecondaryPanelVisibility({
        closePersistedPanel,
        drawerVisibility,
        isCompactViewport: true,
        isPersistedOpen: true,
        openPersistedPanel,
        openPersistedStorageFile: vi.fn(),
        openPersistedWorkspaceFile: vi.fn(),
        togglePersistedPanel,
      });
    });

    expect(result.current.isOpen).toBe(false);
    act(() => result.current.togglePanel());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.closePanel());
    expect(result.current.isOpen).toBe(false);
    expect(closePersistedPanel).not.toHaveBeenCalled();
    expect(openPersistedPanel).not.toHaveBeenCalled();
    expect(togglePersistedPanel).not.toHaveBeenCalled();
  });
});
