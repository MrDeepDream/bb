import type { SidebarTabPlacement } from "./sidebarSplitLayout";

const placementsByPanel = new Map<string, Map<string, SidebarTabPlacement>>();

export function registerRemovedTabPlacements(
  panelStateId: string,
  placements: Map<string, SidebarTabPlacement>,
): () => void {
  placementsByPanel.set(panelStateId, placements);
  return () => {
    if (placementsByPanel.get(panelStateId) === placements) {
      placementsByPanel.delete(panelStateId);
    }
  };
}

export function forgetRemovedTabPlacement(
  panelStateId: string | null,
  tabId: string,
): void {
  if (panelStateId === null) return;
  placementsByPanel.get(panelStateId)?.delete(tabId);
}
