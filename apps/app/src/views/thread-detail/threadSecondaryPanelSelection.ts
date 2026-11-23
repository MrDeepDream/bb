import { useCallback } from "react";
import {
  useCloseFixedSecondaryPanel,
  useFixedPanelTabsState,
  useOpenFixedSecondaryPanel,
  useSetFixedSecondaryPanelTab,
} from "@/lib/fixed-panel-tabs";
import type {
  FixedPanelTabsState,
  SecondaryFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import type { ThreadSecondaryPanel } from "@/lib/thread-secondary-panel";

type ThreadSecondaryPanelThreadId = string | null | undefined;
type ActiveFixedSecondaryTab = SecondaryFixedPanelTab | null;

type NullableSecondaryPanelSetter = (
  panel: ThreadSecondaryPanel | null,
) => void;

interface GetActiveFixedSecondaryTabArgs {
  fixedPanelTabsState: FixedPanelTabsState;
  hidesTerminals: boolean;
}

export function getActiveFixedSecondaryTab({
  fixedPanelTabsState,
  hidesTerminals,
}: GetActiveFixedSecondaryTabArgs): ActiveFixedSecondaryTab {
  const { activeTabId, previousActiveTabId, tabs } =
    fixedPanelTabsState.secondary;
  if (activeTabId === null) {
    return null;
  }
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  if (!hidesTerminals || activeTab?.kind !== "terminal") {
    return activeTab;
  }
  return (
    tabs.find(
      (tab) => tab.id === previousActiveTabId && tab.kind !== "terminal",
    ) ??
    tabs.find((tab) => tab.kind !== "terminal") ??
    null
  );
}

export function isFixedSecondaryPanelOpen(
  args: GetActiveFixedSecondaryTabArgs,
): boolean {
  return (
    args.fixedPanelTabsState.secondary.isOpen &&
    (!args.hidesTerminals || getActiveFixedSecondaryTab(args) !== null)
  );
}

export function useSetThreadSecondaryPanelSelection(
  panelStateId: ThreadSecondaryPanelThreadId,
  syncThreadId: ThreadSecondaryPanelThreadId,
): NullableSecondaryPanelSetter {
  const closeFixedSecondaryPanel = useCloseFixedSecondaryPanel(
    panelStateId,
    syncThreadId,
  );
  const setFixedSecondaryPanelTab = useSetFixedSecondaryPanelTab(
    panelStateId,
    syncThreadId,
  );

  return useCallback<NullableSecondaryPanelSetter>(
    (panel) => {
      if (panel === null) {
        closeFixedSecondaryPanel();
        return;
      }
      setFixedSecondaryPanelTab(panel);
    },
    [closeFixedSecondaryPanel, setFixedSecondaryPanelTab],
  );
}

export function useToggleThreadSecondaryPanelSelection(
  panelStateId: ThreadSecondaryPanelThreadId,
  syncThreadId: ThreadSecondaryPanelThreadId,
  hidesTerminals: boolean,
): () => void {
  const closeFixedSecondaryPanel = useCloseFixedSecondaryPanel(
    panelStateId,
    syncThreadId,
  );
  const openFixedSecondaryPanel = useOpenFixedSecondaryPanel(
    panelStateId,
    syncThreadId,
  );
  const setFixedSecondaryPanelTab = useSetFixedSecondaryPanelTab(
    panelStateId,
    syncThreadId,
  );
  const fixedPanelTabsState = useFixedPanelTabsState(
    panelStateId,
    syncThreadId,
  );
  const isSecondaryPanelOpen = isFixedSecondaryPanelOpen({
    fixedPanelTabsState,
    hidesTerminals,
  });
  const hasVisibleActiveTab =
    getActiveFixedSecondaryTab({ fixedPanelTabsState, hidesTerminals }) !==
    null;

  return useCallback(() => {
    if (isSecondaryPanelOpen) {
      closeFixedSecondaryPanel();
      return;
    }
    if (hidesTerminals && !hasVisibleActiveTab) {
      setFixedSecondaryPanelTab("thread-info");
      return;
    }
    openFixedSecondaryPanel();
  }, [
    closeFixedSecondaryPanel,
    hasVisibleActiveTab,
    hidesTerminals,
    isSecondaryPanelOpen,
    openFixedSecondaryPanel,
    setFixedSecondaryPanelTab,
  ]);
}
