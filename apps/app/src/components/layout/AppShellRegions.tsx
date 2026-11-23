import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useHydrateAtoms } from "jotai/utils";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { observeSharedResize } from "@bb/shared-ui/lib/shared-resize-observer";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useAppCommandRunner,
  useAppCommandShortcut,
  useIsAppCommandAvailable,
} from "@/components/commands/AppCommandProvider";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import type { SecondaryPanelRenderableTab } from "@/components/secondary-panel/secondaryPanelTab";
import type { PanelTerminals } from "@/components/secondary-panel/usePanelTerminals";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import { BbLogo } from "@/components/ui/bb-logo";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar.js";
import {
  bottomRegionHostAtom,
  bottomRegionOpenAtom,
  bottomTerminalIdAtomFamily,
  contentShellHasPanelRoomAtom,
  resolveContentShellHasPanelRoom,
  useUsesAppShellRegions,
} from "@/lib/app-shell-regions";
import {
  getBbDesktopInfo,
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
} from "@/lib/bb-desktop";
import type { TerminalFixedPanelTab } from "@/lib/fixed-panel-tabs-state";

const TITLE_BAR_PLACEHOLDER_MENUS = [
  "File",
  "Edit",
  "View",
  "Session",
  "Help",
] as const;
const WINDOWS_CAPTION_BUTTONS_RESERVE_CLASS =
  "pr-[calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,calc(100vw_-_138px)))]";
const REGION_ICON_BUTTON_CLASS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring";

type TerminalRenderableTab = SecondaryPanelRenderableTab & {
  tab: TerminalFixedPanelTab;
};

function isTerminalRenderableTab(
  entry: SecondaryPanelRenderableTab,
): entry is TerminalRenderableTab {
  return entry.tab.kind === "terminal";
}

function focusNothing(): void {}

export function useContentShellPanelRoom(
  contentShell: HTMLElement | null,
  estimateWidth: () => number,
): void {
  const store = useStore();
  const [estimatedRoom] = useState(() =>
    resolveContentShellHasPanelRoom(estimateWidth()),
  );
  useHydrateAtoms([[contentShellHasPanelRoomAtom, estimatedRoom]], { store });
  useEffect(() => {
    if (contentShell === null) return;
    return observeSharedResize(contentShell, {
      read: () => contentShell.clientWidth,
      write: (width) => {
        if (width === 0) return;
        store.set(
          contentShellHasPanelRoomAtom,
          resolveContentShellHasPanelRoom(width),
        );
      },
    });
  }, [contentShell, store]);
}

function BottomRegionToggle({ className }: { className: string | false }) {
  const [isOpen, setIsOpen] = useAtom(bottomRegionOpenAtom);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-7", className)}
      aria-label="Toggle terminal"
      aria-pressed={isOpen}
      onClick={() => setIsOpen(!isOpen)}
    >
      <Icon name="Terminal" />
    </Button>
  );
}

function AppTitleBarContent({
  showsTerminalToggle,
}: {
  showsTerminalToggle: boolean;
}) {
  const [desktopInfo] = useState(getBbDesktopInfo);
  const isWindowsDesktop = desktopInfo?.platform === "windows";
  const runner = useAppCommandRunner();
  const paletteShortcut = useAppCommandShortcut("palette.open");
  const sidebarShortcut = useAppCommandShortcut("sidebar.toggle");
  const panelShortcut = useAppCommandShortcut("panel.toggle");
  const canTogglePanel = useIsAppCommandAvailable("panel.toggle");
  const { open } = useSidebar();
  const noDragClass = isWindowsDesktop && MACOS_APP_REGION_NO_DRAG_CLASS;
  const applicationMenuButtonRef = useRef<HTMLButtonElement>(null);
  const handleOpenApplicationMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    desktopInfo?.popupApplicationMenu?.({
      x: Math.max(0, Math.round(bounds.left)),
      y: Math.max(0, Math.round(bounds.bottom)),
    });
  };
  useEffect(() => {
    if (!isWindowsDesktop) return;
    return desktopInfo?.onApplicationMenuRequested?.(() => {
      applicationMenuButtonRef.current?.click();
    });
  }, [desktopInfo, isWindowsDesktop]);
  return (
    <div
      data-testid="app-title-bar"
      style={{ zIndex: APP_OVERLAY_LAYER.sidebarTrigger }}
      className={cn(
        "fixed inset-x-0 top-[env(safe-area-inset-top)] grid h-(--bb-app-title-bar-height) grid-cols-[minmax(max-content,1fr)_minmax(240px,560px)_minmax(max-content,1fr)] items-center gap-2 border-b border-border-seam-vertical/60 bg-sidebar px-2 text-sidebar-foreground",
        isWindowsDesktop && MACOS_WINDOW_DRAG_CLASS,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="shrink-0">
          <BbLogo className="size-4" />
        </span>
        {isWindowsDesktop ? (
          <Button
            ref={applicationMenuButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-7", noDragClass)}
            aria-label="Application menu"
            aria-haspopup="menu"
            onClick={handleOpenApplicationMenu}
          >
            <Icon name="MoreHorizontal" />
          </Button>
        ) : null}
        <div
          aria-hidden="true"
          data-testid="app-title-bar-menu-labels"
          className="flex select-none items-center gap-3 text-xs text-muted-foreground"
        >
          {TITLE_BAR_PLACEHOLDER_MENUS.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>
      <button
        type="button"
        aria-label="Search"
        aria-keyshortcuts={paletteShortcut?.ariaKeyshortcuts}
        className={cn(
          "flex h-7 min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring",
          noDragClass,
        )}
        onClick={() => runner.dispatch("palette.open", null)}
      >
        <Icon name="Search" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search</span>
        {paletteShortcut ? (
          <kbd className="shrink-0 font-sans">{paletteShortcut.label}</kbd>
        ) : null}
      </button>
      <div
        className={cn(
          "flex min-w-0 items-center justify-end gap-1",
          isWindowsDesktop && WINDOWS_CAPTION_BUTTONS_RESERVE_CLASS,
        )}
      >
        <SidebarTrigger
          className={cn("size-7", noDragClass)}
          aria-label={
            sidebarShortcut
              ? `Toggle sidebar (${sidebarShortcut.label})`
              : "Toggle sidebar"
          }
          aria-keyshortcuts={sidebarShortcut?.ariaKeyshortcuts}
          aria-pressed={open}
        />
        {canTogglePanel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-7", noDragClass)}
            aria-label="Toggle right panel"
            aria-keyshortcuts={panelShortcut?.ariaKeyshortcuts}
            onClick={() => runner.dispatch("panel.toggle", null)}
          >
            <Icon name={RIGHT_PANEL_TOGGLE_ICON_NAME} />
          </Button>
        ) : null}
        {showsTerminalToggle ? (
          <BottomRegionToggle className={noDragClass} />
        ) : null}
      </div>
    </div>
  );
}

export function AppTitleBar({
  showsTerminalToggle,
}: {
  showsTerminalToggle: boolean;
}) {
  const usesAppShellRegions = useUsesAppShellRegions();
  return usesAppShellRegions ? (
    <AppTitleBarContent showsTerminalToggle={showsTerminalToggle} />
  ) : null;
}

export function AppBottomRegionHost() {
  const usesAppShellRegions = useUsesAppShellRegions();
  const isOpen = useAtomValue(bottomRegionOpenAtom);
  const setHost = useSetAtom(bottomRegionHostAtom);
  if (!usesAppShellRegions || !isOpen) return null;
  return (
    <section
      ref={setHost}
      aria-label="Terminal"
      data-app-bottom-region=""
      data-testid="app-bottom-region"
      className="flex h-[min(300px,40%)] min-h-0 shrink-0 flex-col overflow-hidden border-t border-border-seam-vertical/60"
    />
  );
}

export function BottomTerminalRegion({
  isFocused,
  panelStateId,
  tabs,
  terminals,
}: {
  isFocused: boolean;
  panelStateId: string;
  tabs: readonly SecondaryPanelRenderableTab[];
  terminals: PanelTerminals;
}) {
  const host = useAtomValue(bottomRegionHostAtom);
  const storedTerminalId = useAtomValue(
    bottomTerminalIdAtomFamily(panelStateId),
  );
  if (host === null || !isFocused) return null;
  const terminalTabs = tabs.filter(isTerminalRenderableTab);
  const activeTab =
    terminalTabs.find((entry) => entry.tab.terminalId === storedTerminalId) ??
    terminalTabs[0] ??
    null;
  return createPortal(
    activeTab === null ? (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!terminals.canStart}
          onClick={terminals.start}
        >
          Start terminal
        </Button>
      </div>
    ) : (
      <>
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border-seam-vertical/60 px-2">
          {terminalTabs.map((entry) => (
            <div
              key={entry.tab.id}
              className={cn(
                "flex shrink-0 items-center rounded-sm",
                entry === activeTab && "bg-accent text-accent-foreground",
              )}
            >
              <button
                type="button"
                aria-pressed={entry === activeTab}
                className="flex h-6 max-w-48 items-center gap-1 rounded-sm px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
                onClick={entry.onSelect}
              >
                {entry.leadingVisual}
                <span className="truncate">{entry.label}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${entry.label}`}
                className={REGION_ICON_BUTTON_CLASS}
                onClick={entry.onClose}
              >
                <Icon name="X" className="size-3" />
              </button>
            </div>
          ))}
          {terminals.canStart ? (
            <button
              type="button"
              aria-label="New terminal"
              className={REGION_ICON_BUTTON_CLASS}
              onClick={terminals.start}
            >
              <Icon name="Plus" className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div
          key={activeTab.tab.id}
          data-bottom-terminal-id={activeTab.tab.terminalId}
          className="flex min-h-0 flex-1 flex-col"
        >
          {activeTab.renderContent({
            isFocused: true,
            onFocusPane: focusNothing,
          })}
        </div>
      </>
    ),
    host,
  );
}
