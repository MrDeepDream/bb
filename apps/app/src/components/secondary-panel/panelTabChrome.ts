import { useSyncExternalStore } from "react";

export type PanelTabChrome = {
  pinnedTabIds: readonly string[];
  previewTabId: string | null;
};

const STORAGE_PREFIX = "bb.thread.secondaryPanelTabChrome.";
const EMPTY_CHROME: PanelTabChrome = { pinnedTabIds: [], previewTabId: null };

const chromeByPanel = new Map<string, PanelTabChrome>();
const listeners = new Set<() => void>();

function parseChrome(raw: string | null): PanelTabChrome {
  if (raw === null) return EMPTY_CHROME;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_CHROME;
    const { pinnedTabIds, previewTabId } = parsed as Record<string, unknown>;
    return {
      pinnedTabIds: Array.isArray(pinnedTabIds)
        ? pinnedTabIds.filter((id): id is string => typeof id === "string")
        : [],
      previewTabId: typeof previewTabId === "string" ? previewTabId : null,
    };
  } catch {
    return EMPTY_CHROME;
  }
}

function readStorage(panelStateId: string): string | null {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${panelStateId}`);
  } catch {
    return null;
  }
}

function writeStorage(panelStateId: string, chrome: PanelTabChrome): void {
  try {
    const key = `${STORAGE_PREFIX}${panelStateId}`;
    if (chrome.pinnedTabIds.length === 0 && chrome.previewTabId === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(chrome));
    }
  } catch {
    return;
  }
}

export function getPanelTabChrome(panelStateId: string | null): PanelTabChrome {
  if (panelStateId === null || typeof window === "undefined") {
    return EMPTY_CHROME;
  }
  const cached = chromeByPanel.get(panelStateId);
  if (cached !== undefined) return cached;
  const loaded = parseChrome(readStorage(panelStateId));
  chromeByPanel.set(panelStateId, loaded);
  return loaded;
}

function updateChrome(
  panelStateId: string,
  update: (current: PanelTabChrome) => PanelTabChrome,
): void {
  const current = getPanelTabChrome(panelStateId);
  const next = update(current);
  if (next === current) return;
  chromeByPanel.set(panelStateId, next);
  writeStorage(panelStateId, next);
  for (const listener of listeners) listener();
}

export function setPanelTabPinned(
  panelStateId: string,
  tabId: string,
  isPinned: boolean,
): void {
  updateChrome(panelStateId, (current) => {
    if (current.pinnedTabIds.includes(tabId) === isPinned) return current;
    return {
      pinnedTabIds: isPinned
        ? [...current.pinnedTabIds, tabId]
        : current.pinnedTabIds.filter((id) => id !== tabId),
      previewTabId:
        current.previewTabId === tabId ? null : current.previewTabId,
    };
  });
}

export function setPanelPreviewTab(
  panelStateId: string,
  tabId: string | null,
): void {
  updateChrome(panelStateId, (current) =>
    current.previewTabId === tabId
      ? current
      : { ...current, previewTabId: tabId },
  );
}

export function clearPanelTabPreviews(tabIds: readonly string[]): void {
  if (tabIds.length === 0) return;
  const cleared = new Set(tabIds);
  for (const [panelStateId, chrome] of chromeByPanel) {
    if (chrome.previewTabId !== null && cleared.has(chrome.previewTabId)) {
      setPanelPreviewTab(panelStateId, null);
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanelTabChrome(panelStateId: string | null): PanelTabChrome {
  return useSyncExternalStore(
    subscribe,
    () => getPanelTabChrome(panelStateId),
    () => EMPTY_CHROME,
  );
}
