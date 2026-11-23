import { useSyncExternalStore } from "react";
import type { ExperimentalFileOpenerCloseGuard } from "@get-bb/plugin-sdk/app";
import { getBbDesktopInfo } from "./bb-desktop";

type CloseGuard = ExperimentalFileOpenerCloseGuard;

type DirtyEntry = { guard: CloseGuard; documentKey: string };

export type PendingFileTabClose = {
  documentCount: number;
  isSaving: boolean;
  error: string | null;
};

type PendingRequest = {
  documents: ReadonlyMap<CloseGuard, ReadonlySet<string>>;
  perform: () => void;
  view: PendingFileTabClose;
};

type TabCloser = (tabIds: readonly string[]) => void;

type BbDesktop = NonNullable<ReturnType<typeof getBbDesktopInfo>>;

const EMPTY_DIRTY: ReadonlyMap<string, DirtyEntry> = new Map();
const UNSAVED_UNLOAD_MESSAGE =
  "Some files have unsaved changes. Leave this page? Your drafts stay on this computer.";

let guards: readonly CloseGuard[] = [];
let unsubscribeGuards: readonly (() => void)[] = [];
let dirtySnapshot = EMPTY_DIRTY;
let pendingRequest: PendingRequest | null = null;
let closeBatch: Map<TabCloser, string[]> | null = null;
let publishedHasDirty = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isSameDirty(
  first: ReadonlyMap<string, DirtyEntry>,
  second: ReadonlyMap<string, DirtyEntry>,
): boolean {
  if (first.size !== second.size) return false;
  for (const [tabId, entry] of first) {
    const other = second.get(tabId);
    if (other?.guard !== entry.guard) return false;
    if (other.documentKey !== entry.documentKey) return false;
  }
  return true;
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

function publishHasDirty(): void {
  const hasDirty = dirtySnapshot.size > 0;
  if (hasDirty === publishedHasDirty) return;
  publishedHasDirty = hasDirty;
  const desktop = getBbDesktopInfo();
  if (desktop !== null) {
    desktop.setHasUnsavedEditors?.(hasDirty);
  } else if (hasDirty) {
    window.addEventListener("beforeunload", handleBeforeUnload);
  } else {
    window.removeEventListener("beforeunload", handleBeforeUnload);
  }
}

function refreshDirty(): void {
  const next = new Map<string, DirtyEntry>();
  for (const guard of guards) {
    for (const [tabId, documentKey] of guard.dirty()) {
      next.set(tabId, { guard, documentKey });
    }
  }
  if (isSameDirty(dirtySnapshot, next)) return;
  dirtySnapshot = next.size === 0 ? EMPTY_DIRTY : next;
  publishHasDirty();
  emit();
}

export function setFileOpenerCloseGuards(next: readonly CloseGuard[]): void {
  if (
    next.length === guards.length &&
    next.every((guard, index) => guard === guards[index])
  ) {
    return;
  }
  for (const unsubscribe of unsubscribeGuards) unsubscribe();
  guards = next;
  unsubscribeGuards = next.map((guard) => guard.subscribe(refreshDirty));
  refreshDirty();
}

function addDocument(
  documents: Map<CloseGuard, Set<string>>,
  { guard, documentKey }: DirtyEntry,
): void {
  const keys = documents.get(guard) ?? new Set<string>();
  keys.add(documentKey);
  documents.set(guard, keys);
}

export function requestFileTabsClose({
  tabIds,
  panelTabIds,
  perform,
}: {
  tabIds: readonly string[];
  panelTabIds: readonly string[];
  perform: () => void;
}): void {
  refreshDirty();
  const closing = new Set(tabIds);
  const staying = new Map<CloseGuard, Set<string>>();
  for (const tabId of panelTabIds) {
    if (closing.has(tabId)) continue;
    const entry = dirtySnapshot.get(tabId);
    if (entry !== undefined) addDocument(staying, entry);
  }
  const documents = new Map<CloseGuard, Set<string>>();
  for (const tabId of closing) {
    const entry = dirtySnapshot.get(tabId);
    if (entry === undefined) continue;
    if (staying.get(entry.guard)?.has(entry.documentKey)) continue;
    addDocument(documents, entry);
  }
  if (documents.size === 0) {
    perform();
    return;
  }
  if (pendingRequest !== null) return;
  let documentCount = 0;
  for (const keys of documents.values()) documentCount += keys.size;
  pendingRequest = {
    documents,
    perform,
    view: { documentCount, isSaving: false, error: null },
  };
  emit();
}

function updatePendingView(view: PendingFileTabClose): void {
  if (pendingRequest === null) return;
  pendingRequest = { ...pendingRequest, view };
  emit();
}

export function cancelPendingFileTabClose(): void {
  if (pendingRequest === null || pendingRequest.view.isSaving) return;
  pendingRequest = null;
  emit();
}

export function discardPendingFileTabClose(): void {
  const request = pendingRequest;
  if (request === null || request.view.isSaving) return;
  pendingRequest = null;
  request.perform();
  for (const [guard, keys] of request.documents) guard.discard([...keys]);
  refreshDirty();
  emit();
}

export async function savePendingFileTabClose(): Promise<void> {
  const request = pendingRequest;
  if (request === null || request.view.isSaving) return;
  updatePendingView({ ...request.view, isSaving: true, error: null });
  let saved = false;
  try {
    const results = await Promise.all(
      [...request.documents].map(([guard, keys]) => guard.save([...keys])),
    );
    saved = results.every(Boolean);
  } catch {
    saved = false;
  }
  if (!saved) {
    updatePendingView({
      ...request.view,
      isSaving: false,
      error: "Some files could not be saved. Your edits are still open.",
    });
    return;
  }
  pendingRequest = null;
  request.perform();
  refreshDirty();
  emit();
}

export function batchFileTabClose(run: () => void): void {
  if (closeBatch !== null) {
    run();
    return;
  }
  const batch = new Map<TabCloser, string[]>();
  closeBatch = batch;
  try {
    run();
  } finally {
    closeBatch = null;
  }
  for (const [closeTabs, tabIds] of batch) closeTabs(tabIds);
}

export function addToFileTabCloseBatch(
  closeTabs: TabCloser,
  tabId: string,
): boolean {
  if (closeBatch === null) return false;
  const tabIds = closeBatch.get(closeTabs) ?? [];
  tabIds.push(tabId);
  closeBatch.set(closeTabs, tabIds);
  return true;
}

export function hasDirtyFileTabs(): boolean {
  refreshDirty();
  return dirtySnapshot.size > 0;
}

export function whenNoDirtyFileTabs(run: () => void): void {
  if (!hasDirtyFileTabs()) {
    run();
    return;
  }
  const unsubscribe = subscribe(() => {
    if (dirtySnapshot.size > 0) return;
    unsubscribe();
    run();
  });
}

async function confirmDesktopUnload(desktop: BbDesktop): Promise<boolean> {
  if (desktop.confirmUnsavedEditorsUnload === undefined) {
    return window.confirm(UNSAVED_UNLOAD_MESSAGE);
  }
  try {
    return await desktop.confirmUnsavedEditorsUnload();
  } catch {
    return false;
  }
}

export function requestPageUnload(
  unload: () => void,
  onStay?: () => void,
): void {
  if (!hasDirtyFileTabs()) {
    unload();
    return;
  }
  const desktop = getBbDesktopInfo();
  if (desktop === null) {
    unload();
    onStay?.();
    return;
  }
  void confirmDesktopUnload(desktop).then((approved) => {
    if (approved) unload();
    else onStay?.();
  });
}

export function isFileTabDirty(tabId: string): boolean {
  return dirtySnapshot.has(tabId);
}

export function getDirtyFileTabIds(): readonly string[] {
  return [...dirtySnapshot.keys()];
}

export function subscribeDirtyFileTabs(listener: () => void): () => void {
  return subscribe(listener);
}

export function useIsFileTabDirty(tabId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => dirtySnapshot.has(tabId),
    () => false,
  );
}

export function usePendingFileTabClose(): PendingFileTabClose | null {
  return useSyncExternalStore(
    subscribe,
    () => pendingRequest?.view ?? null,
    () => null,
  );
}
