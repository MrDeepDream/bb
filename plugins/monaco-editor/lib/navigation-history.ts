import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";

export const MAX_HISTORY_ENTRIES = 64;
const JUMP_MIN_LINES = 8;

export type EditorLocation = {
  documentKey: string;
  tabId: string;
  path: string;
  absolutePath: string;
  source: PluginFileOpenerSource;
  hostId: string | null;
  lineNumber: number;
  column: number;
};

export type NavigationHistory = {
  entries: EditorLocation[];
  index: number;
  pending: EditorLocation | null;
};

export function createNavigationHistory(): NavigationHistory {
  return { entries: [], index: -1, pending: null };
}

function push(history: NavigationHistory, location: EditorLocation): void {
  history.entries.length = history.index + 1;
  history.entries.push(location);
  if (history.entries.length > MAX_HISTORY_ENTRIES) history.entries.shift();
  history.index = history.entries.length - 1;
}

function isSamePlace(
  first: EditorLocation | undefined,
  second: EditorLocation,
): boolean {
  return (
    first !== undefined &&
    first.documentKey === second.documentKey &&
    first.lineNumber === second.lineNumber &&
    first.column === second.column
  );
}

export function syncCurrentLocation(
  history: NavigationHistory,
  location: EditorLocation,
): void {
  const { entries, index } = history;
  if (entries[index]?.documentKey !== location.documentKey) return;
  entries[index] = location;
  if (isSamePlace(entries[index + 1], location)) entries.splice(index + 1, 1);
  if (isSamePlace(entries[index - 1], location)) {
    entries.splice(index - 1, 1);
    history.index = index - 1;
  }
}

export function recordFileSwitch(
  history: NavigationHistory,
  location: EditorLocation,
): void {
  if (history.entries[history.index]?.documentKey === location.documentKey) {
    syncCurrentLocation(history, location);
    return;
  }
  push(history, location);
}

export function recordJump(
  history: NavigationHistory,
  from: EditorLocation,
  to: EditorLocation,
): void {
  recordFileSwitch(history, from);
  if (
    from.documentKey === to.documentKey &&
    from.lineNumber === to.lineNumber
  ) {
    syncCurrentLocation(history, to);
    return;
  }
  push(history, to);
}

export function stepHistory(
  history: NavigationHistory,
  delta: -1 | 1,
  current: EditorLocation | null,
  visit: (target: EditorLocation) => boolean,
): EditorLocation | null {
  if (current !== null) syncCurrentLocation(history, current);
  const origin = history.index;
  const here = current ?? history.entries[origin];
  for (
    let index = origin + delta;
    index >= 0 && index < history.entries.length;
    index += delta
  ) {
    const target = history.entries[index];
    if (target === undefined) continue;
    if (here !== undefined && isSamePlace(target, here)) continue;
    history.index = index;
    if (visit(target)) return target;
  }
  history.index = origin;
  return null;
}

export function takePendingLocation(
  history: NavigationHistory,
  documentKey: string,
): EditorLocation | null {
  const pending = history.pending;
  history.pending = null;
  return pending?.documentKey === documentKey ? pending : null;
}

export function isNavigationJump(
  event: { reason: number; source: string; position: { lineNumber: number } },
  explicitReason: number,
  previousLine: number,
): boolean {
  return (
    event.reason === explicitReason &&
    event.source !== "keyboard" &&
    Math.abs(event.position.lineNumber - previousLine) >= JUMP_MIN_LINES
  );
}
