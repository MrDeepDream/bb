import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import {
  closeSecondaryPanelTabInState,
  createNewTabFixedPanelTab,
} from "@bb/client-core";
import type {
  TerminalCreateTarget,
  TerminalSession,
} from "@bb/server-contract";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";
import { usePendingTerminals } from "@/components/thread/terminal/pending-terminals";
import { applyTerminalSessionUpsert } from "@/hooks/cache-owners/terminal-cache-owner";
import {
  bottomRegionOpenAtom,
  bottomTerminalIdAtomFamily,
  focusedBottomTerminalId,
} from "@/lib/app-shell-regions";
import {
  addFixedRightTerminalTabInState,
  replaceFixedRightTerminalTabInState,
  restoreFixedRightTerminalTabInState,
  useRemoveFixedRightTerminalTab,
  useSetFixedRightTerminalActiveTerminal,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import { isVisibleTerminalSession } from "@/lib/terminal-session-visibility";

interface UsePanelTerminalsArgs {
  panelStateId: string | null | undefined;
  syncThreadId: string | null | undefined;
  createTarget: TerminalCreateTarget | null;
  isFocused: boolean;
  acceptsSession: (session: TerminalSession) => boolean;
  tabsCarryTarget: boolean;
  reveal: () => void;
  usesBottomRegion: boolean;
  onCloseLastTab?: () => void;
}

export interface PanelTerminals {
  autoFocusTerminalId: string | null;
  canStart: boolean;
  close: (terminalId: string) => void;
  closeFocusedBottomTerminal: () => boolean;
  handleAutoFocusHandled: () => void;
  open: (session: TerminalSession) => boolean;
  retryStart: (terminalId: string) => void;
  select: (terminalId: string, target?: TerminalCreateTarget) => void;
  start: () => void;
}

export function terminalTargetForSession(
  session: TerminalSession,
): TerminalCreateTarget {
  if (session.threadId !== null) {
    return { kind: "thread", threadId: session.threadId };
  }
  if (session.environmentId !== null) {
    return { kind: "environment", environmentId: session.environmentId };
  }
  return { kind: "host_path", hostId: session.hostId, cwd: session.initialCwd };
}

export function usePanelTerminals({
  panelStateId,
  syncThreadId,
  createTarget,
  isFocused,
  acceptsSession,
  tabsCarryTarget,
  reveal,
  usesBottomRegion,
  onCloseLastTab,
}: UsePanelTerminalsArgs): PanelTerminals {
  const [autoFocusTerminalId, setAutoFocusTerminalId] = useState<string | null>(
    null,
  );
  const setBottomRegionOpen = useSetAtom(bottomRegionOpenAtom);
  const setBottomTerminalId = useSetAtom(
    bottomTerminalIdAtomFamily(panelStateId ?? ""),
  );
  const queryClient = useQueryClient();
  const pendingTerminals = usePendingTerminals();
  const updatePanelState = useUpdateFixedPanelTabsState(
    panelStateId,
    syncThreadId,
  );
  const setActiveTerminal = useSetFixedRightTerminalActiveTerminal(
    panelStateId,
    syncThreadId,
  );
  const removeTerminalTab = useRemoveFixedRightTerminalTab(
    panelStateId,
    syncThreadId,
    onCloseLastTab,
  );

  const select = useCallback(
    (terminalId: string, target?: TerminalCreateTarget) => {
      setAutoFocusTerminalId(terminalId);
      if (usesBottomRegion) {
        updatePanelState((state) =>
          addFixedRightTerminalTabInState(state, terminalId, target),
        );
        setBottomTerminalId(terminalId);
        setBottomRegionOpen(true);
        return;
      }
      setActiveTerminal(terminalId, target);
      reveal();
    },
    [
      reveal,
      setActiveTerminal,
      setBottomRegionOpen,
      setBottomTerminalId,
      updatePanelState,
      usesBottomRegion,
    ],
  );

  const open = useCallback(
    (session: TerminalSession) => {
      if (!isVisibleTerminalSession(session) || !acceptsSession(session)) {
        return false;
      }
      applyTerminalSessionUpsert({ queryClient, session });
      select(
        session.id,
        tabsCarryTarget ? terminalTargetForSession(session) : undefined,
      );
      return true;
    },
    [acceptsSession, queryClient, select, tabsCarryTarget],
  );

  const canStart = createTarget !== null;
  const start = useCallback(() => {
    if (createTarget === null) return;
    const terminalId = pendingTerminals.start({
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
      target: createTarget,
    });
    if (!usesBottomRegion) {
      updatePanelState((state) =>
        closeSecondaryPanelTabInState(state, createNewTabFixedPanelTab().id),
      );
    }
    select(terminalId, tabsCarryTarget ? createTarget : undefined);
  }, [
    createTarget,
    select,
    tabsCarryTarget,
    pendingTerminals,
    updatePanelState,
    usesBottomRegion,
  ]);

  useAppCommandHandler("terminal.open", () => {
    if (!isFocused || !canStart) return false;
    start();
    return true;
  });

  const close = useCallback(
    (terminalId: string) => {
      if (pendingTerminals.discard(terminalId) !== null) {
        removeTerminalTab(terminalId);
        return;
      }
      const removed = removeTerminalTab(terminalId);
      pendingTerminals.close(terminalId, () => {
        if (removed === null) return;
        let reopensPanel = false;
        updatePanelState((state) => {
          reopensPanel = !usesBottomRegion && state.secondary.tabs.length === 0;
          return restoreFixedRightTerminalTabInState(
            state,
            removed,
            !usesBottomRegion,
          );
        });
        if (reopensPanel) reveal();
      });
    },
    [
      pendingTerminals,
      removeTerminalTab,
      reveal,
      updatePanelState,
      usesBottomRegion,
    ],
  );

  const closeFocusedBottomTerminal = useCallback(() => {
    if (!usesBottomRegion) return false;
    const terminalId = focusedBottomTerminalId();
    if (terminalId === null) return false;
    close(terminalId);
    return true;
  }, [close, usesBottomRegion]);

  const retryStart = useCallback(
    (terminalId: string) => {
      const failed = pendingTerminals.discard(terminalId);
      if (failed === null) return;
      const nextTerminalId = pendingTerminals.start(failed.request);
      updatePanelState((state) =>
        replaceFixedRightTerminalTabInState(
          state,
          terminalId,
          nextTerminalId,
          tabsCarryTarget ? failed.request.target : undefined,
          !usesBottomRegion,
        ),
      );
      if (usesBottomRegion) setBottomTerminalId(nextTerminalId);
      setAutoFocusTerminalId(nextTerminalId);
    },
    [
      tabsCarryTarget,
      pendingTerminals,
      setBottomTerminalId,
      updatePanelState,
      usesBottomRegion,
    ],
  );

  const handleAutoFocusHandled = useCallback(
    () => setAutoFocusTerminalId(null),
    [],
  );

  return {
    autoFocusTerminalId,
    canStart,
    close,
    closeFocusedBottomTerminal,
    handleAutoFocusHandled,
    open,
    retryStart,
    select,
    start,
  };
}
