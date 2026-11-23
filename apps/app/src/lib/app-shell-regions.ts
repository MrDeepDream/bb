import { useState } from "react";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { getBbDesktopInfo, shouldUseMacosDesktopChrome } from "./bb-desktop";
import type {
  FixedPanelTab,
  TerminalFixedPanelTab,
} from "./fixed-panel-tabs-state";

export const CONTENT_SHELL_PANEL_ROOM_PX = 880;

export const contentShellHasPanelRoomAtom = atom<boolean | null>(null);
export const bottomRegionOpenAtom = atom(false);
export const bottomRegionHostAtom = atom<HTMLElement | null>(null);
export const bottomTerminalIdAtomFamily = atomFamily((_panelStateId: string) =>
  atom<string | null>(null),
);
export const homeNewTabDismissedAtom = atom(false);

export function resolveContentShellHasPanelRoom(width: number): boolean {
  return width >= CONTENT_SHELL_PANEL_ROOM_PX;
}

export function useUsesAppShellRegions(): boolean {
  const isCompactViewport = useIsCompactViewport();
  const [desktopInfo] = useState(getBbDesktopInfo);
  return !isCompactViewport && !shouldUseMacosDesktopChrome(desktopInfo);
}

export function resolveBottomTerminalTab(
  tabs: readonly FixedPanelTab[],
  terminalId: string | null,
): TerminalFixedPanelTab | null {
  let firstTerminalTab: TerminalFixedPanelTab | null = null;
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    if (tab.terminalId === terminalId) return tab;
    firstTerminalTab ??= tab;
  }
  return firstTerminalTab;
}

export function focusedBottomTerminalId(): string | null {
  const focused = document.activeElement;
  if (!(focused instanceof Element)) return null;
  if (
    focused.closest("[data-app-bottom-region] [data-app-terminal]") === null
  ) {
    return null;
  }
  return (
    focused
      .closest("[data-bottom-terminal-id]")
      ?.getAttribute("data-bottom-terminal-id") ?? null
  );
}
