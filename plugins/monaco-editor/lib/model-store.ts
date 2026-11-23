import type {
  ExperimentalPanelTabs,
  PluginFileOpenerSource,
  PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import type { rpcContract } from "./rpc-contract.js";
import { deleteDraft, readDraft, writeDraft } from "./draft-journal.js";
import { MAX_FINGERPRINT_PATHS } from "./host-contract.js";
import { languageForPath } from "./languages.js";
import {
  createNavigationHistory,
  type NavigationHistory,
} from "./navigation-history.js";

type Monaco = typeof MonacoNs;
type TextModel = MonacoNs.editor.ITextModel;
type ViewState = MonacoNs.editor.ICodeEditorViewState;
type StoreRpc = Pick<PluginRpcClient<typeof rpcContract>, "call">;

type TextFile = {
  content: string;
  sha256: string;
  absolutePath: string;
  relativePath: string;
  documentKey: string;
  hostId: string | null;
  readOnly: boolean;
  fingerprint: string | null;
};

export type DocumentMeta = {
  key: string;
  uri: string;
  path: string;
  source: PluginFileOpenerSource;
  hostId: string | null;
  absolutePath: string;
  relativePath: string;
  baseSha: string | null;
  fingerprint: string | null;
  pendingFingerprint: string | null | undefined;
  savedVersion: number;
  dirty: boolean;
  readOnly: boolean;
  mixedEol: boolean;
  saving: boolean;
  refreshing: boolean;
  conflict: { currentSha256: string | null } | null;
  reloaded: { discardedText: string; discardedSha256: string | null } | null;
  saveError: string | null;
  restoredDraft: boolean;
  draftRestoring: boolean;
  discarding: boolean;
  lastUsed: number;
  attachedEditors: number;
};

export type WorkspaceTab = {
  documentKey: string;
  openedAs: string | null;
  viewState: ViewState | null;
};

type ModelEditBinding = {
  handler: (key: string) => void;
  listener: MonacoNs.IDisposable;
};

export type WorkspaceAnchor = {
  monaco: Monaco | null;
  documents: Map<string, DocumentMeta>;
  tabs: Map<string, WorkspaceTab>;
  pendingJournal: Set<string>;
  revision: number;
  usageClock: number;
  history: NavigationHistory;
  keymapInstalled: boolean;
  modelEditListeners: WeakMap<TextModel, ModelEditBinding>;
};

type LaterAnchorFields = "history" | "keymapInstalled" | "modelEditListeners";

type AdoptedAnchor = Omit<WorkspaceAnchor, LaterAnchorFields> &
  Partial<Pick<WorkspaceAnchor, LaterAnchorFields>>;

const ANCHOR_KEY = Symbol.for("bb.monaco-editor.workspace");
const CHANGE_EVENT = "bb.monaco-editor.workspace-changed";
const MAX_CLEAN_DOCUMENTS = 48;
const MAX_CLEAN_CHARACTERS = 128 * 1024 * 1024;
const MAX_TAB_ENTRIES = 512;
const JOURNAL_DEBOUNCE_MS = 600;
const JOURNAL_MAX_WAIT_MS = 5_000;
const MAX_WATCHED_DOCUMENTS = 256;
const UTF8_BOM = "﻿";

let storeRpc: StoreRpc | null = null;
const savesInFlight = new Map<string, Promise<boolean>>();
let journalTimer: ReturnType<typeof setTimeout> | null = null;
let journalWaitStartedAt: number | null = null;
let journalFlush: Promise<void> | null = null;
let applyingProgrammaticEdit = false;
const documentsToRevalidate = new Set<string>();
let revalidating = false;

export function workspaceAnchor(): WorkspaceAnchor {
  const scope = globalThis as unknown as Record<symbol, unknown>;
  const existing = scope[ANCHOR_KEY] as AdoptedAnchor | undefined;
  if (existing !== undefined) {
    existing.history ??= createNavigationHistory();
    existing.keymapInstalled ??= false;
    existing.modelEditListeners ??= new WeakMap();
    return existing as WorkspaceAnchor;
  }
  const created: WorkspaceAnchor = {
    monaco: null,
    documents: new Map(),
    tabs: new Map(),
    pendingJournal: new Set(),
    revision: 0,
    usageClock: 0,
    history: createNavigationHistory(),
    keymapInstalled: false,
    modelEditListeners: new WeakMap(),
  };
  scope[ANCHOR_KEY] = created;
  return created;
}

export function bindStoreRpc(rpc: StoreRpc): void {
  storeRpc = rpc;
}

export function adoptWorkspace(): void {
  const anchor = workspaceAnchor();
  for (const meta of anchor.documents.values()) {
    meta.hostId ??= meta.source.experimental_hostId ?? null;
    const model = modelForDocument(meta);
    if (model !== null) bindModelEdits(meta.key, model);
  }
  for (const entry of anchor.history.entries) {
    entry.hostId ??= entry.source.experimental_hostId ?? null;
  }
  if (anchor.pendingJournal.size > 0) void flushJournal();
}

function bindModelEdits(key: string, model: TextModel): void {
  const { modelEditListeners } = workspaceAnchor();
  const bound = modelEditListeners.get(model);
  if (bound?.handler === markDocumentEdited) return;
  bound?.listener.dispose();
  modelEditListeners.set(model, {
    handler: markDocumentEdited,
    listener: model.onDidChangeContent(() => markDocumentEdited(key)),
  });
}

export function tabOpenKey(
  path: string,
  source: PluginFileOpenerSource,
): string {
  return JSON.stringify([path, source]);
}

export function installJournalLifecycleFlush(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const flush = () => {
    if (document.visibilityState === "hidden") void flushJournal();
  };
  const flushNow = () => void flushJournal();
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", flush);
  return () => {
    window.removeEventListener("pagehide", flushNow);
    document.removeEventListener("visibilitychange", flush);
  };
}

export function notifyWorkspace(): void {
  workspaceAnchor().revision += 1;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

export function subscribeWorkspace(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function getWorkspaceRevision(): number {
  return workspaceAnchor().revision;
}

export function modelForDocument(meta: DocumentMeta): TextModel | null {
  const monaco = workspaceAnchor().monaco;
  if (monaco === null) return null;
  return monaco.editor.getModel(monaco.Uri.parse(meta.uri));
}

function hasMixedEol(text: string): boolean {
  if (/\r(?!\n)/u.test(text)) return true;
  let sawCrlf = false;
  let sawLf = false;
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  ) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) sawCrlf = true;
    else sawLf = true;
    if (sawCrlf && sawLf) return true;
  }
  return false;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function replaceModelText(monaco: Monaco, model: TextModel, raw: string): void {
  applyingProgrammaticEdit = true;
  try {
    writeModelText(monaco, model, raw);
  } finally {
    applyingProgrammaticEdit = false;
  }
}

function writeModelText(monaco: Monaco, model: TextModel, raw: string): void {
  const hasBom = raw.startsWith(UTF8_BOM);
  if (hasBom !== model.getValue(undefined, true).startsWith(UTF8_BOM)) {
    model.setValue(raw);
    return;
  }
  const text = hasBom ? raw.slice(1) : raw;
  model.pushStackElement();
  const sequence = text.includes("\r\n")
    ? monaco.editor.EndOfLineSequence.CRLF
    : monaco.editor.EndOfLineSequence.LF;
  const wantsCrlf = sequence === monaco.editor.EndOfLineSequence.CRLF;
  if ((model.getEOL() === "\r\n") !== wantsCrlf) model.pushEOL(sequence);
  const next = text.replace(/\r\n|\r|\n/gu, model.getEOL());
  const current = model.getValue();
  if (current !== next) {
    const limit = Math.min(current.length, next.length);
    let prefix = 0;
    while (
      prefix < limit &&
      current.charCodeAt(prefix) === next.charCodeAt(prefix)
    ) {
      prefix += 1;
    }
    if (
      prefix > 0 &&
      (isHighSurrogate(current.charCodeAt(prefix - 1)) ||
        current.charCodeAt(prefix - 1) === 13)
    ) {
      prefix -= 1;
    }
    let suffix = 0;
    while (
      suffix < limit - prefix &&
      current.charCodeAt(current.length - 1 - suffix) ===
        next.charCodeAt(next.length - 1 - suffix)
    ) {
      suffix += 1;
    }
    if (
      suffix > 0 &&
      (isLowSurrogate(current.charCodeAt(current.length - suffix)) ||
        current.charCodeAt(current.length - suffix) === 10)
    ) {
      suffix -= 1;
    }
    const start = model.getPositionAt(prefix);
    const end = model.getPositionAt(current.length - suffix);
    model.pushEditOperations(
      [],
      [
        {
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
          text: next.slice(prefix, next.length - suffix),
        },
      ],
      () => null,
    );
  }
  model.pushStackElement();
}

function documentUri(monaco: Monaco, key: string, path: string) {
  const basename = path.split(/[\\/]/u).at(-1) ?? "file";
  return monaco.Uri.from({
    scheme: "bb-document",
    path: `/${encodeURIComponent(key)}/${encodeURIComponent(basename)}`,
  });
}

function touch(meta: DocumentMeta): void {
  const anchor = workspaceAnchor();
  anchor.usageClock += 1;
  meta.lastUsed = anchor.usageClock;
}

function syncDirtyFlag(meta: DocumentMeta, model: TextModel): boolean {
  const dirty = model.getAlternativeVersionId() !== meta.savedVersion;
  if (dirty === meta.dirty) return false;
  meta.dirty = dirty;
  return true;
}

function applyDiskFile(
  monaco: Monaco,
  model: TextModel,
  meta: DocumentMeta,
  file: TextFile,
): void {
  replaceModelText(monaco, model, file.content);
  meta.baseSha = file.sha256;
  meta.fingerprint = file.fingerprint;
  meta.savedVersion = model.getAlternativeVersionId();
  meta.dirty = false;
  meta.discarding = false;
  meta.mixedEol = hasMixedEol(file.content);
  meta.readOnly = file.readOnly;
}

function reconcileDiskFile(
  monaco: Monaco,
  model: TextModel,
  meta: DocumentMeta,
  file: TextFile,
): boolean {
  if (file.sha256 === meta.baseSha) {
    if (meta.conflict === null) return false;
    if (meta.conflict.currentSha256 === meta.baseSha) return false;
    meta.conflict = null;
    return true;
  }
  syncDirtyFlag(meta, model);
  if (meta.dirty) {
    meta.conflict = { currentSha256: file.sha256 };
  } else {
    applyDiskFile(monaco, model, meta, file);
    meta.conflict = null;
    meta.reloaded = null;
  }
  return true;
}

export async function openDocument({
  monaco,
  file,
  path,
  source,
  tabId,
}: {
  monaco: Monaco;
  file: TextFile;
  path: string;
  source: PluginFileOpenerSource;
  tabId: string;
}): Promise<DocumentMeta> {
  const anchor = workspaceAnchor();
  anchor.monaco = monaco;
  let meta = anchor.documents.get(file.documentKey);
  const liveModel = meta === undefined ? null : modelForDocument(meta);
  if (meta !== undefined && liveModel !== null) {
    meta.hostId = file.hostId;
    bindModelEdits(meta.key, liveModel);
    if (file.sha256 !== meta.baseSha && !meta.saving && !meta.refreshing) {
      await compareWithDisk(meta, file.fingerprint);
    }
  } else {
    const uri = documentUri(monaco, file.documentKey, path);
    const model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(file.content, languageForPath(path), uri);
    meta = {
      key: file.documentKey,
      uri: uri.toString(),
      path,
      source,
      hostId: file.hostId,
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      baseSha: file.sha256,
      fingerprint: file.fingerprint,
      pendingFingerprint: undefined,
      savedVersion: model.getAlternativeVersionId(),
      dirty: false,
      readOnly: file.readOnly,
      mixedEol: hasMixedEol(file.content),
      saving: false,
      refreshing: false,
      conflict: null,
      reloaded: null,
      saveError: null,
      restoredDraft: false,
      draftRestoring: true,
      discarding: false,
      lastUsed: 0,
      attachedEditors: 0,
    };
    anchor.documents.set(file.documentKey, meta);
    bindModelEdits(file.documentKey, model);
    const draft = await readDraft(file.documentKey);
    const mayRestore = meta.draftRestoring;
    meta.draftRestoring = false;
    if (draft !== null && mayRestore && modelForDocument(meta) === model) {
      if (draft.text === model.getValue(undefined, true)) {
        void deleteDraft(file.documentKey).catch(() => undefined);
      } else {
        replaceModelText(monaco, model, draft.text);
        meta.baseSha = draft.baseSha;
        meta.restoredDraft = true;
        meta.dirty = model.getAlternativeVersionId() !== meta.savedVersion;
        if (draft.baseSha !== file.sha256) {
          meta.conflict = { currentSha256: file.sha256 };
        }
      }
    }
  }
  const previous = anchor.tabs.get(tabId);
  anchor.tabs.delete(tabId);
  anchor.tabs.set(tabId, {
    documentKey: file.documentKey,
    openedAs: tabOpenKey(path, source),
    viewState:
      previous?.documentKey === file.documentKey ? previous.viewState : null,
  });
  pruneTabEntries(anchor);
  touch(meta);
  evictCleanDocuments();
  notifyWorkspace();
  return meta;
}

function pruneTabEntries(anchor: WorkspaceAnchor): void {
  if (anchor.tabs.size <= MAX_TAB_ENTRIES) return;
  for (const [tabId, tab] of anchor.tabs) {
    if (anchor.tabs.size <= MAX_TAB_ENTRIES) return;
    const meta = anchor.documents.get(tab.documentKey);
    if (meta === undefined || (!meta.dirty && meta.attachedEditors === 0)) {
      anchor.tabs.delete(tabId);
    }
  }
}

export function evictCleanDocuments(): void {
  const anchor = workspaceAnchor();
  const candidates: { meta: DocumentMeta; model: TextModel }[] = [];
  let cleanCount = 0;
  let cleanCharacters = 0;
  for (const meta of anchor.documents.values()) {
    const model = modelForDocument(meta);
    if (model === null) continue;
    if (meta.dirty || meta.saving) continue;
    cleanCount += 1;
    cleanCharacters += model.getValueLength();
    if (meta.attachedEditors === 0) candidates.push({ meta, model });
  }
  if (
    cleanCount <= MAX_CLEAN_DOCUMENTS &&
    cleanCharacters <= MAX_CLEAN_CHARACTERS
  ) {
    return;
  }
  candidates.sort(
    (first, second) => first.meta.lastUsed - second.meta.lastUsed,
  );
  for (const { meta, model } of candidates) {
    if (
      cleanCount <= MAX_CLEAN_DOCUMENTS &&
      cleanCharacters <= MAX_CLEAN_CHARACTERS
    ) {
      return;
    }
    cleanCount -= 1;
    cleanCharacters -= model.getValueLength();
    anchor.documents.delete(meta.key);
    model.dispose();
  }
}

export function attachEditor(key: string, tabId: string): void {
  const anchor = workspaceAnchor();
  const meta = anchor.documents.get(key);
  if (meta === undefined) return;
  const model = modelForDocument(meta);
  if (model !== null) bindModelEdits(key, model);
  meta.attachedEditors += 1;
  touch(meta);
  const existing = anchor.tabs.get(tabId);
  if (existing === undefined || existing.documentKey !== key) {
    anchor.tabs.set(tabId, {
      documentKey: key,
      openedAs: null,
      viewState: null,
    });
    notifyWorkspace();
  } else {
    anchor.tabs.delete(tabId);
    anchor.tabs.set(tabId, existing);
  }
}

export function listedTabForDocument(
  documentKey: string,
  panelTabs: ExperimentalPanelTabs,
  preferredTabId: string | null,
): string | null {
  const { tabs } = workspaceAnchor();
  const listed = new Set(panelTabs.tabs.map(({ key }) => key));
  const showsDocument = (tabId: string | null): tabId is string =>
    tabId !== null &&
    listed.has(tabId) &&
    tabs.get(tabId)?.documentKey === documentKey;
  if (showsDocument(preferredTabId)) return preferredTabId;
  if (showsDocument(panelTabs.selectedKey)) return panelTabs.selectedKey;
  let latest: string | null = null;
  for (const [tabId, tab] of tabs) {
    if (tab.documentKey === documentKey && listed.has(tabId)) latest = tabId;
  }
  return latest;
}

export function detachEditor(
  key: string,
  tabId: string,
  viewState: ViewState | null,
): void {
  const anchor = workspaceAnchor();
  const tab = anchor.tabs.get(tabId);
  if (tab !== undefined && tab.documentKey === key) tab.viewState = viewState;
  const meta = anchor.documents.get(key);
  if (meta === undefined) return;
  if (meta.attachedEditors > 0) meta.attachedEditors -= 1;
  if (meta.discarding && meta.attachedEditors === 0) {
    dropDocument(anchor, meta);
    notifyWorkspace();
  }
}

export function viewStateForTab(tabId: string): ViewState | null {
  return workspaceAnchor().tabs.get(tabId)?.viewState ?? null;
}

export function liveDocumentForTab(
  tabId: string,
  openKey: string,
): DocumentMeta | null {
  return workspaceAnchor().tabs.get(tabId)?.openedAs === openKey
    ? documentForTab(tabId)
    : null;
}

export function documentForTab(tabId: string): DocumentMeta | null {
  const anchor = workspaceAnchor();
  const key = anchor.tabs.get(tabId)?.documentKey;
  if (key === undefined) return null;
  const meta = anchor.documents.get(key);
  if (meta === undefined || modelForDocument(meta) === null) return null;
  return meta;
}

export function dirtyTabs(): ReadonlyMap<string, string> {
  const anchor = workspaceAnchor();
  const dirty = new Map<string, string>();
  for (const [tabId, tab] of anchor.tabs) {
    const meta = anchor.documents.get(tab.documentKey);
    if (meta?.dirty && !meta.discarding) dirty.set(tabId, tab.documentKey);
  }
  return dirty;
}

function markDocumentEdited(key: string): void {
  if (applyingProgrammaticEdit) return;
  const meta = workspaceAnchor().documents.get(key);
  if (meta === undefined) return;
  const model = modelForDocument(meta);
  if (model === null) return;
  let changed = syncDirtyFlag(meta, model);
  if (meta.discarding) {
    meta.discarding = false;
    changed = true;
  }
  if (meta.reloaded !== null) {
    meta.reloaded = null;
    changed = true;
  }
  if (meta.restoredDraft && !meta.dirty) {
    meta.restoredDraft = false;
    changed = true;
  }
  scheduleJournal(key);
  if (changed) notifyWorkspace();
}

function scheduleJournal(key: string): void {
  workspaceAnchor().pendingJournal.add(key);
  const now = Date.now();
  journalWaitStartedAt ??= now;
  if (journalTimer !== null) clearTimeout(journalTimer);
  const delay = Math.min(
    JOURNAL_DEBOUNCE_MS,
    Math.max(0, journalWaitStartedAt + JOURNAL_MAX_WAIT_MS - now),
  );
  journalTimer = setTimeout(() => {
    journalTimer = null;
    journalWaitStartedAt = null;
    runWhenIdle(() => void flushJournal());
  }, delay);
}

function runWhenIdle(task: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(task, { timeout: 1_000 });
  } else {
    setTimeout(task, 0);
  }
}

export function flushJournal(): Promise<void> {
  if (journalFlush !== null) {
    return journalFlush.then(() => {
      if (workspaceAnchor().pendingJournal.size > 0) return flushJournal();
      return undefined;
    });
  }
  const running = writePendingDrafts().finally(() => {
    journalFlush = null;
  });
  journalFlush = running;
  return running;
}

async function writePendingDrafts(): Promise<void> {
  const anchor = workspaceAnchor();
  const keys = [...anchor.pendingJournal];
  anchor.pendingJournal.clear();
  for (const key of keys) {
    const meta = anchor.documents.get(key);
    const model = meta === undefined ? null : modelForDocument(meta);
    try {
      if (
        meta !== undefined &&
        model !== null &&
        meta.dirty &&
        !meta.discarding
      ) {
        await writeDraft({
          key,
          text: model.getValue(undefined, true),
          baseSha: meta.baseSha,
        });
      } else {
        await deleteDraft(key);
      }
    } catch {
      anchor.pendingJournal.add(key);
    }
  }
}

export function saveDocument(key: string): Promise<boolean> {
  const running = savesInFlight.get(key);
  if (running !== undefined) {
    return running.then(() =>
      workspaceAnchor().documents.get(key)?.dirty ? saveDocument(key) : true,
    );
  }
  const meta = workspaceAnchor().documents.get(key);
  if (meta === undefined) return Promise.resolve(true);
  if (meta.saving || meta.conflict !== null) return Promise.resolve(false);
  return startWrite(meta, meta.baseSha);
}

export function overwriteDocument(key: string): Promise<boolean> {
  const meta = workspaceAnchor().documents.get(key);
  if (meta === undefined || meta.conflict === null || meta.saving) {
    return Promise.resolve(false);
  }
  return startWrite(meta, meta.conflict.currentSha256);
}

function startWrite(
  meta: DocumentMeta,
  expectedSha256: string | null,
): Promise<boolean> {
  const model = modelForDocument(meta);
  if (model === null || meta.readOnly || storeRpc === null) {
    return Promise.resolve(false);
  }
  const running = writeSnapshot(storeRpc, meta, model, expectedSha256).finally(
    () => {
      savesInFlight.delete(meta.key);
      const pending = meta.pendingFingerprint;
      meta.pendingFingerprint = undefined;
      if (pending !== undefined) void reconcileFingerprint(meta.key, pending);
    },
  );
  savesInFlight.set(meta.key, running);
  return running;
}

async function writeSnapshot(
  rpc: StoreRpc,
  meta: DocumentMeta,
  model: TextModel,
  expectedSha256: string | null,
): Promise<boolean> {
  meta.saving = true;
  meta.saveError = null;
  notifyWorkspace();
  const version = model.getAlternativeVersionId();
  const content = model.getValue(undefined, true);
  try {
    const result = await rpc.call("write", {
      path: meta.path,
      source: meta.source,
      content,
      expectedSha256,
    });
    if (result.outcome === "conflict") {
      meta.conflict = { currentSha256: result.currentSha256 };
      return false;
    }
    meta.baseSha = result.sha256;
    meta.fingerprint = null;
    meta.savedVersion = version;
    meta.conflict = null;
    meta.reloaded = null;
    meta.restoredDraft = false;
    meta.mixedEol = false;
    return true;
  } catch (error) {
    meta.saveError = error instanceof Error ? error.message : "Save failed";
    return false;
  } finally {
    meta.saving = false;
    if (!model.isDisposed()) syncDirtyFlag(meta, model);
    scheduleJournal(meta.key);
    notifyWorkspace();
  }
}

export function applyFingerprints(
  fingerprints: Readonly<Record<string, string | null>>,
): void {
  const documents = workspaceAnchor().documents;
  for (const [key, fingerprint] of Object.entries(fingerprints)) {
    const meta = documents.get(key);
    if (meta === undefined) continue;
    const isNews =
      fingerprint === null
        ? meta.conflict?.currentSha256 !== null
        : meta.fingerprint !== fingerprint;
    if (isNews) void reconcileFingerprint(key, fingerprint);
  }
}

export function revalidateDocument(key: string): void {
  documentsToRevalidate.add(key);
  if (revalidating) return;
  revalidating = true;
  void Promise.resolve().then(drainRevalidations);
}

async function drainRevalidations(): Promise<void> {
  const { documents } = workspaceAnchor();
  while (documentsToRevalidate.size > 0 && storeRpc !== null) {
    const batch = [...documentsToRevalidate].slice(0, MAX_FINGERPRINT_PATHS);
    for (const key of batch) documentsToRevalidate.delete(key);
    const targets = batch.flatMap((key) => {
      const meta = documents.get(key);
      return meta === undefined
        ? []
        : [{ path: meta.path, source: meta.source }];
    });
    if (targets.length === 0) continue;
    try {
      const { fingerprints } = await storeRpc.call("documentFingerprints", {
        documents: targets,
      });
      applyFingerprints(fingerprints);
    } catch {
      continue;
    }
  }
  documentsToRevalidate.clear();
  revalidating = false;
}

export async function reconcileFingerprint(
  key: string,
  fingerprint: string | null,
): Promise<void> {
  const meta = workspaceAnchor().documents.get(key);
  if (meta === undefined || storeRpc === null) return;
  if (meta.saving || meta.refreshing) {
    meta.pendingFingerprint = fingerprint;
    return;
  }
  if (fingerprint === null) {
    meta.fingerprint = null;
    if (meta.conflict?.currentSha256 !== null) {
      meta.conflict = { currentSha256: null };
      notifyWorkspace();
    }
    return;
  }
  await compareWithDisk(meta, fingerprint);
}

async function compareWithDisk(
  meta: DocumentMeta,
  fingerprint: string | null,
): Promise<void> {
  const anchor = workspaceAnchor();
  if (storeRpc === null) return;
  meta.refreshing = true;
  try {
    const file = await storeRpc.call("read", {
      path: meta.path,
      source: meta.source,
    });
    if (file.kind !== "text") {
      meta.fingerprint = fingerprint;
      return;
    }
    const model = modelForDocument(meta);
    if (
      model === null ||
      anchor.monaco === null ||
      anchor.documents.get(meta.key) !== meta
    ) {
      return;
    }
    const changed = reconcileDiskFile(anchor.monaco, model, meta, file);
    meta.fingerprint = fingerprint ?? file.fingerprint;
    if (changed) notifyWorkspace();
  } catch {
    meta.fingerprint = null;
  } finally {
    meta.refreshing = false;
    const pending = meta.pendingFingerprint;
    meta.pendingFingerprint = undefined;
    if (pending !== undefined && pending !== meta.fingerprint) {
      void reconcileFingerprint(meta.key, pending);
    }
  }
}

export async function reloadDocument(key: string): Promise<boolean> {
  const anchor = workspaceAnchor();
  const meta = anchor.documents.get(key);
  if (meta === undefined || storeRpc === null || anchor.monaco === null) {
    return false;
  }
  const monaco = anchor.monaco;
  const versionBeforeRead =
    modelForDocument(meta)?.getAlternativeVersionId() ?? null;
  meta.refreshing = true;
  notifyWorkspace();
  try {
    const file = await storeRpc.call("read", {
      path: meta.path,
      source: meta.source,
    });
    if (file.kind !== "text") {
      meta.saveError = file.reason;
      return false;
    }
    const model = modelForDocument(meta);
    if (model === null || anchor.documents.get(key) !== meta) return false;
    if (model.getAlternativeVersionId() !== versionBeforeRead) {
      syncDirtyFlag(meta, model);
      if (meta.dirty) {
        meta.fingerprint = file.fingerprint;
        meta.conflict =
          file.sha256 === meta.baseSha ? null : { currentSha256: file.sha256 };
        scheduleJournal(key);
        return false;
      }
    }
    const discarded =
      meta.conflict === null
        ? null
        : {
            discardedText: model.getValue(undefined, true),
            discardedSha256: meta.baseSha,
          };
    applyDiskFile(monaco, model, meta, file);
    meta.conflict = null;
    meta.reloaded = discarded;
    meta.saveError = null;
    meta.restoredDraft = false;
    scheduleJournal(key);
    return true;
  } catch (error) {
    meta.saveError = error instanceof Error ? error.message : "Reload failed";
    return false;
  } finally {
    meta.refreshing = false;
    if (
      meta.discarding &&
      meta.attachedEditors === 0 &&
      anchor.documents.get(key) === meta
    ) {
      dropDocument(anchor, meta);
    }
    notifyWorkspace();
  }
}

export function undoReload(key: string): void {
  const anchor = workspaceAnchor();
  const meta = anchor.documents.get(key);
  if (meta === undefined || meta.reloaded === null || anchor.monaco === null) {
    return;
  }
  const model = modelForDocument(meta);
  if (model === null) return;
  const { discardedText, discardedSha256 } = meta.reloaded;
  const currentSha256 = meta.baseSha;
  replaceModelText(anchor.monaco, model, discardedText);
  meta.baseSha = discardedSha256;
  meta.reloaded = null;
  meta.conflict = { currentSha256 };
  syncDirtyFlag(meta, model);
  scheduleJournal(key);
  notifyWorkspace();
}

export function dismissRestoredDraft(key: string): void {
  const meta = workspaceAnchor().documents.get(key);
  if (meta === undefined || !meta.restoredDraft) return;
  meta.restoredDraft = false;
  notifyWorkspace();
}

function dropDocument(anchor: WorkspaceAnchor, meta: DocumentMeta): void {
  const model = modelForDocument(meta);
  anchor.documents.delete(meta.key);
  anchor.pendingJournal.delete(meta.key);
  for (const [tabId, tab] of anchor.tabs) {
    if (tab.documentKey === meta.key) anchor.tabs.delete(tabId);
  }
  model?.dispose();
}

export function discardDocuments(keys: readonly string[]): void {
  const anchor = workspaceAnchor();
  for (const key of keys) {
    anchor.pendingJournal.delete(key);
    void deleteDraft(key).catch(() => undefined);
    const meta = anchor.documents.get(key);
    if (meta === undefined) continue;
    if (meta.attachedEditors > 1) {
      meta.discarding = true;
      meta.draftRestoring = false;
      meta.restoredDraft = false;
      meta.conflict = null;
      void reloadDocument(key);
      continue;
    }
    dropDocument(anchor, meta);
  }
  notifyWorkspace();
}

export const workspaceCloseGuard = {
  subscribe: subscribeWorkspace,
  dirty: dirtyTabs,
  async save(documentKeys: readonly string[]): Promise<boolean> {
    const results = await Promise.all(documentKeys.map(saveDocument));
    return results.every(Boolean);
  },
  discard: discardDocuments,
};

export function fingerprintQueryDocuments(): {
  path: string;
  source: PluginFileOpenerSource;
}[] {
  return [...workspaceAnchor().documents.values()]
    .sort((first, second) => second.lastUsed - first.lastUsed)
    .slice(0, MAX_WATCHED_DOCUMENTS)
    .sort((first, second) => first.key.localeCompare(second.key))
    .map((meta) => ({ path: meta.path, source: meta.source }));
}
