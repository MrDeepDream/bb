import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { experimental_joinHostPath as joinHostPath } from "@get-bb/plugin-sdk";
import {
  definePluginApp,
  experimental_useAppPanel,
  experimental_useCodeTheme,
  experimental_useRpcQuery,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalFilePreviewOptions,
  type ExperimentalLiveFileTarget,
  type PluginFileOpenerProps,
  type PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import { Icon } from "@/components/ui/icon";
import { GIT_MARKERS_CHANNEL, rpcContract } from "./lib/rpc-contract.js";
import {
  installGitMarkers,
  invalidateGitMarkers,
  scheduleGitMarkerRefresh,
} from "./lib/git-markers.js";
import { CLAIMED_EXTENSIONS } from "./lib/languages.js";
import {
  loadMonaco,
  overflowWidgetsNode,
  setOverflowWidgetsTheme,
} from "./lib/monaco-loader.js";
import { applyCodeTheme, editorBackground } from "./lib/monaco-theme.js";
import { cn } from "@/lib/utils";
import { FileToolbar, type SaveIndicator } from "./components/FileToolbar.js";
import { FileTreePanel } from "./components/FileTreePanel.js";
import {
  FindInFilesOverlay,
  type FindInFilesResult,
} from "./components/FindInFilesPanel.js";
import type { FlatEntry } from "./lib/file-tree.js";
import {
  EDITOR_COMMANDS,
  forgetEditor,
  isCommandAvailable,
  markEditorActive,
  openFileFromLastEditor,
  runEditorCommand,
  showInOpenTabFromLastEditor,
  type ActiveEditor,
} from "./lib/editor-commands.js";
import { documentKeyFor } from "./lib/document-key.js";
import {
  adoptWorkspace,
  applyFingerprints,
  attachEditor,
  bindStoreRpc,
  detachEditor,
  dismissRestoredDraft,
  documentForTab,
  fingerprintQueryDocuments,
  flushJournal,
  getWorkspaceRevision,
  installJournalLifecycleFlush,
  listedTabForDocument,
  liveDocumentForTab,
  modelForDocument,
  notifyWorkspace,
  openDocument,
  overwriteDocument,
  reloadDocument,
  revalidateDocument,
  saveDocument,
  subscribeWorkspace,
  tabOpenKey,
  undoReload,
  viewStateForTab,
  workspaceAnchor,
  workspaceCloseGuard,
  type DocumentMeta,
} from "./lib/model-store.js";
import {
  cancelFindJumpFocus,
  requestFindJumpFocus,
  takeFindJumpFocus,
} from "./lib/find-in-files-state.js";
import { installJetbrainsKeymap, isMacKeymapPlatform } from "./lib/keymap.js";
import {
  isNavigationJump,
  recordFileSwitch,
  recordJump,
  stepHistory,
  syncCurrentLocation,
  takePendingLocation,
  type EditorLocation,
} from "./lib/navigation-history.js";

type LineRange = PluginFileOpenerProps["experimental_lineRange"];

type OpenerStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "delegate"; reason: string }
  | { kind: "error"; message: string };

type TreeState = {
  entries: readonly FlatEntry[];
  root: string;
  hostId: string | null;
  environmentId: string | null;
  truncated: boolean;
  isLoading: boolean;
  error: string | null;
};

const EMPTY_TREE: TreeState = {
  entries: [],
  root: "",
  hostId: null,
  environmentId: null,
  truncated: false,
  isLoading: false,
  error: null,
};

const revealedRanges = new Map<string, string>();

function revealPosition(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  target: { lineNumber: number; column: number },
) {
  const model = editor.getModel();
  if (model === null) return;
  const position = model.validatePosition(target);
  editor.setPosition(position);
  editor.revealPositionInCenter(position);
}

function revealLineRange(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  lineRange: LineRange,
  column: number | null,
) {
  const model = editor.getModel();
  if (lineRange == null || model === null) return;
  if (
    column !== null &&
    lineRange.startLineNumber === lineRange.endLineNumber
  ) {
    revealPosition(editor, { lineNumber: lineRange.startLineNumber, column });
    return;
  }
  const startLineNumber = Math.min(
    lineRange.startLineNumber,
    model.getLineCount(),
  );
  const endLineNumber = Math.min(lineRange.endLineNumber, model.getLineCount());
  const selection = {
    startLineNumber,
    startColumn: 1,
    endLineNumber,
    endColumn: model.getLineMaxColumn(endLineNumber),
  };
  editor.setSelection(selection);
  editor.revealRangeInCenter(selection);
}

function liveFileTarget(
  source: PluginFileOpenerSource,
  tree: Pick<TreeState, "root" | "hostId" | "environmentId">,
  entryPath: string,
): ExperimentalLiveFileTarget | null {
  if (source.kind === "thread-storage") {
    return source.threadId === null
      ? null
      : { kind: "thread-storage", threadId: source.threadId, path: entryPath };
  }
  if (tree.environmentId !== null) {
    return {
      kind: "workspace",
      environmentId: tree.environmentId,
      path: entryPath,
    };
  }
  const absolute = joinHostPath({
    rootPath: tree.root,
    relativePath: entryPath,
  });
  return tree.hostId === null || absolute === null
    ? null
    : { kind: "host", hostId: tree.hostId, path: absolute };
}

function locationFileTarget({
  absolutePath,
  hostId,
  path,
  source,
}: EditorLocation): ExperimentalLiveFileTarget | null {
  if (source.kind === "thread-storage") {
    return source.threadId === null
      ? null
      : { kind: "thread-storage", threadId: source.threadId, path };
  }
  if (source.kind === "workspace" && source.environmentId !== null) {
    return { kind: "workspace", environmentId: source.environmentId, path };
  }
  return hostId === null ? null : { kind: "host", hostId, path: absolutePath };
}

function MonacoFileOpener({
  path,
  source,
  Original,
  experimental_lineRange,
  experimental_column,
  experimental_tabId,
}: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const panel = experimental_useAppPanel();
  const codeTheme = experimental_useCodeTheme();
  const codeThemeRef = useRef(codeTheme);
  codeThemeRef.current = codeTheme;
  const generatedTabId = useId();
  const tabId = experimental_tabId ?? `opener:${generatedTabId}`;
  const sourceKey = JSON.stringify(source);
  const openKey = tabOpenKey(path, source);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const conflictNoticeRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const attachedRef = useRef<{ key: string; tabId: string } | null>(null);
  const activeRef = useRef<ActiveEditor | null>(null);
  const lineRangeRef = useRef<LineRange>(experimental_lineRange);
  const columnRef = useRef(experimental_column ?? null);
  const handledRangeRef = useRef<LineRange>(null);
  const breadcrumbRef = useRef<HTMLElement | null>(null);
  const lastPositionRef = useRef<MonacoNs.IPosition | null>(null);
  const suppressJumpRef = useRef(false);

  const [status, setStatus] = useState<OpenerStatus>({ kind: "loading" });
  const [pendingDiscard, setPendingDiscard] = useState(false);
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);

  useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceRevision,
    getWorkspaceRevision,
  );
  const meta = status.kind === "ready" ? documentForTab(tabId) : null;
  const hasReloadedNotice = meta !== null && meta.reloaded !== null;
  const readOnly = meta?.readOnly ?? false;

  useEffect(() => {
    bindStoreRpc(rpc);
  }, [rpc]);

  const save = useCallback(async () => {
    const current = documentForTab(tabId);
    if (current === null || current.readOnly) return;
    if (current.conflict !== null) {
      conflictNoticeRef.current?.focus();
      return;
    }
    await saveDocument(current.key);
  }, [tabId]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const currentLocation = useCallback(
    (position?: MonacoNs.IPosition | null): EditorLocation | null => {
      const attached = attachedRef.current;
      const at = position ?? editorRef.current?.getPosition() ?? null;
      const current = attached === null ? null : documentForTab(attached.tabId);
      if (attached === null || at === null || current === null) return null;
      return {
        documentKey: current.key,
        tabId: attached.tabId,
        path: current.path,
        absolutePath: current.absolutePath,
        source: current.source,
        hostId: current.hostId,
        lineNumber: at.lineNumber,
        column: at.column,
      };
    },
    [],
  );

  const revealRequestedRange = useCallback(() => {
    const editor = editorRef.current;
    const range = lineRangeRef.current;
    if (editor === null || range == null) return;
    if (handledRangeRef.current === range) return;
    const isFirstInMount = handledRangeRef.current === null;
    handledRangeRef.current = range;
    const column = columnRef.current;
    const takesFocus = takeFindJumpFocus(range.startLineNumber, column);
    const rangeKey = `${range.startLineNumber}:${range.endLineNumber}:${column}`;
    const isMountReveal = suppressJumpRef.current;
    if (
      isFirstInMount &&
      isMountReveal &&
      !takesFocus &&
      revealedRanges.get(tabId) === rangeKey
    ) {
      return;
    }
    revealedRanges.set(tabId, rangeKey);
    const from = isMountReveal ? null : currentLocation();
    suppressJumpRef.current = true;
    revealLineRange(editor, range, column);
    suppressJumpRef.current = isMountReveal;
    const to = from === null ? null : currentLocation();
    if (from !== null && to !== null) {
      recordJump(workspaceAnchor().history, from, to);
    }
    if (takesFocus) editor.focus();
  }, [currentLocation, tabId]);

  const revealHistoryLocation = useCallback(
    (editor: MonacoNs.editor.IStandaloneCodeEditor, target: EditorLocation) => {
      suppressJumpRef.current = true;
      revealPosition(editor, target);
      suppressJumpRef.current = false;
      editor.focus();
    },
    [],
  );

  const showLocation = useCallback(
    (target: EditorLocation): boolean => {
      const anchor = workspaceAnchor();
      const { history } = anchor;
      const tabId =
        listedTabForDocument(
          target.documentKey,
          panel.getTabs(),
          target.tabId,
        ) ?? target.tabId;
      const editor = editorRef.current;
      if (
        editor !== null &&
        attachedRef.current?.tabId === tabId &&
        attachedRef.current.key === target.documentKey
      ) {
        revealHistoryLocation(editor, target);
        return true;
      }
      history.pending = { ...target, tabId };
      if (
        anchor.tabs.get(tabId)?.documentKey === target.documentKey &&
        panel.selectTab(tabId)
      ) {
        notifyWorkspace();
        return true;
      }
      const fileTarget = locationFileTarget(target);
      if (
        fileTarget !== null &&
        navigate.experimental_openFilePreview({
          target: fileTarget,
          location: null,
          opener: MONACO_OPENER_ID,
        })
      ) {
        return true;
      }
      history.pending = null;
      return false;
    },
    [navigate, panel, revealHistoryLocation],
  );

  const walkHistory = useCallback(
    (delta: -1 | 1) => {
      const { history } = workspaceAnchor();
      const unreachable: EditorLocation[] = [];
      const reached = stepHistory(
        history,
        delta,
        currentLocation(),
        (target) => {
          if (showLocation(target)) return true;
          unreachable.push(target);
          return false;
        },
      );
      if (reached === null && unreachable.length > 0) {
        toast.error("Could not reopen this file");
      }
    },
    [currentLocation, showLocation],
  );
  const walkHistoryRef = useRef(walkHistory);
  walkHistoryRef.current = walkHistory;

  const showInOpenTab = useCallback(
    (documentKey: string, lineNumber: number, column: number): boolean => {
      const { documents, history } = workspaceAnchor();
      const document = documents.get(documentKey);
      if (document === undefined) return false;
      const attached = attachedRef.current;
      const tabId = listedTabForDocument(
        documentKey,
        panel.getTabs(),
        attached?.key === documentKey ? attached.tabId : null,
      );
      if (tabId === null) return false;
      const to: EditorLocation = {
        documentKey,
        tabId,
        path: document.path,
        absolutePath: document.absolutePath,
        source: document.source,
        hostId: document.hostId,
        lineNumber,
        column,
      };
      const earlier = { entries: [...history.entries], index: history.index };
      const from = currentLocation();
      if (from === null) recordFileSwitch(history, to);
      else recordJump(history, from, to);
      if (showLocation(to)) return true;
      history.entries = earlier.entries;
      history.index = earlier.index;
      return false;
    },
    [currentLocation, panel, showLocation],
  );
  const showInOpenTabRef = useRef(showInOpenTab);
  useEffect(() => {
    showInOpenTabRef.current = showInOpenTab;
  }, [showInOpenTab]);

  useEffect(
    () =>
      subscribeWorkspace(() => {
        const editor = editorRef.current;
        const attached = attachedRef.current;
        const { history } = workspaceAnchor();
        const pending = history.pending;
        if (
          editor === null ||
          attached === null ||
          pending === null ||
          suppressJumpRef.current ||
          pending.tabId !== attached.tabId ||
          pending.documentKey !== attached.key
        ) {
          return;
        }
        history.pending = null;
        revealHistoryLocation(editor, pending);
      }),
    [revealHistoryLocation],
  );

  useEffect(() => {
    if (hasReloadedNotice) conflictNoticeRef.current?.focus();
  }, [hasReloadedNotice]);

  const treeKey =
    source.kind === "host" ? `${sourceKey}\u0000${path}` : sourceKey;
  const treeRequestedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isFilesOpen || treeRequestedRef.current === treeKey) return;
    treeRequestedRef.current = treeKey;
    let cancelled = false;
    setTree((current) => ({ ...current, isLoading: true, error: null }));
    void rpc
      .call("tree", { path, source })
      .then((result) => {
        if (cancelled) return;
        setTree({
          entries: result.entries,
          root: result.root,
          hostId: result.hostId,
          environmentId: result.environmentId,
          truncated: result.truncated,
          isLoading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        treeRequestedRef.current = null;
        setTree({
          ...EMPTY_TREE,
          error:
            error instanceof Error ? error.message : "Could not list files",
        });
      });
    return () => {
      cancelled = true;
      if (treeRequestedRef.current === treeKey) {
        treeRequestedRef.current = null;
      }
    };
  }, [isFilesOpen, path, rpc, source, treeKey]);

  const openTreeEntry = (entryPath: string) => {
    const target = liveFileTarget(source, tree, entryPath);
    if (
      target === null ||
      !navigate.experimental_openFilePreview({
        target,
        location: null,
        opener: MONACO_OPENER_ID,
      })
    ) {
      toast.error("Could not open this file");
    }
  };

  const requestRefresh = () => {
    if (meta === null) return;
    if (meta.dirty) {
      setPendingDiscard(true);
      return;
    }
    void reloadDocument(meta.key);
  };

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    setPendingDiscard(false);

    const mountEditor = (
      monaco: typeof MonacoNs,
      container: HTMLElement,
    ): MonacoNs.editor.IStandaloneCodeEditor => {
      if (editorRef.current !== null) return editorRef.current;
      const applied = applyCodeTheme(monaco, codeThemeRef.current);
      setOverflowWidgetsTheme(applied.base);
      const editor = monaco.editor.create(container, {
        model: null,
        automaticLayout: true,
        lineNumbers: "on",
        theme: applied.name,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        lineHeight: 20,
        fontFamily:
          getComputedStyle(document.documentElement).getPropertyValue(
            "--font-mono",
          ) || undefined,
        fixedOverflowWidgets: true,
        overflowWidgetsDomNode: overflowWidgetsNode(),
      });
      editorRef.current = editor;
      installJetbrainsKeymap(monaco);
      editor.onDidFocusEditorWidget(() => {
        if (activeRef.current !== null) markEditorActive(activeRef.current);
        const { history } = workspaceAnchor();
        const location = currentLocation();
        if (location !== null && history.pending === null) {
          recordFileSwitch(history, location);
        }
      });
      editor.onDidChangeCursorPosition((event) => {
        const previous = lastPositionRef.current;
        lastPositionRef.current = event.position;
        if (
          suppressJumpRef.current ||
          previous === null ||
          !isNavigationJump(
            event,
            monaco.editor.CursorChangeReason.Explicit,
            previous.lineNumber,
          )
        ) {
          return;
        }
        const to = currentLocation(event.position);
        if (to === null) return;
        recordJump(
          workspaceAnchor().history,
          { ...to, lineNumber: previous.lineNumber, column: previous.column },
          to,
        );
      });
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => void saveRef.current(),
      );
      if (!isMacKeymapPlatform()) {
        editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, () =>
          walkHistoryRef.current(-1),
        );
        editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, () =>
          walkHistoryRef.current(1),
        );
      }
      return editor;
    };

    void (async () => {
      try {
        const anchor = workspaceAnchor();
        let document = liveDocumentForTab(tabId, openKey);
        if (document === null) {
          const [assets, file] = await Promise.all([
            anchor.monaco === null ? rpc.call("assets") : null,
            rpc.call("read", { path, source }),
          ]);
          if (cancelled) return;
          if (file.kind === "unsupported") {
            setStatus({ kind: "delegate", reason: file.reason });
            return;
          }
          const monaco =
            anchor.monaco ??
            (await loadMonaco((assets ?? (await rpc.call("assets"))).baseUrl));
          if (cancelled) return;
          document = await openDocument({ monaco, file, path, source, tabId });
          if (cancelled) return;
        } else if (document.attachedEditors === 0) {
          revalidateDocument(document.key);
        }
        const monaco = anchor.monaco;
        const container = containerRef.current;
        const model = modelForDocument(document);
        if (monaco === null || container === null || model === null) return;
        const editor = mountEditor(monaco, container);
        attachEditor(document.key, tabId);
        attachedRef.current = { key: document.key, tabId };
        scheduleGitMarkerRefresh();
        suppressJumpRef.current = true;
        editor.setModel(model);
        editor.updateOptions({ readOnly: document.readOnly });
        const viewState = viewStateForTab(tabId);
        if (viewState !== null) editor.restoreViewState(viewState);
        const active = {
          editor,
          absolutePath: document.absolutePath,
          relativePath: document.relativePath,
          searchFile: { path, source },
          openFile: (options: ExperimentalFilePreviewOptions) =>
            navigateRef.current.experimental_openFilePreview(options),
          showInOpenTab: (key: string, lineNumber: number, column: number) =>
            showInOpenTabRef.current(key, lineNumber, column),
          walkHistory: (delta: -1 | 1) => walkHistoryRef.current(delta),
          focusBreadcrumbs: () =>
            breadcrumbRef.current?.querySelector("button")?.focus(),
        };
        activeRef.current = active;
        markEditorActive(active);
        const { history } = workspaceAnchor();
        const pending = takePendingLocation(history, document.key);
        if (pending === null) {
          revealRequestedRange();
        } else {
          revealPosition(editor, pending);
          editor.focus();
        }
        suppressJumpRef.current = false;
        lastPositionRef.current = editor.getPosition();
        const location = currentLocation();
        if (location !== null) {
          if (pending === null) recordFileSwitch(history, location);
          else syncCurrentLocation(history, location);
        }
        setStatus({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setStatus({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not open this file",
        });
      }
    })();

    return () => {
      cancelled = true;
      suppressJumpRef.current = false;
      const { history } = workspaceAnchor();
      const leaving = currentLocation();
      if (leaving !== null && history.pending === null) {
        syncCurrentLocation(history, leaving);
      }
      lastPositionRef.current = null;
      const attached = attachedRef.current;
      const editor = editorRef.current;
      attachedRef.current = null;
      activeRef.current = null;
      if (attached !== null && editor !== null) {
        const viewState = editor.saveViewState();
        editor.setModel(null);
        detachEditor(attached.key, attached.tabId, viewState);
      }
    };
  }, [
    currentLocation,
    openKey,
    path,
    revealRequestedRange,
    rpc,
    source,
    tabId,
  ]);

  useEffect(
    () => () => {
      const editor = editorRef.current;
      if (editor === null) return;
      forgetEditor(editor);
      editor.dispose();
      editorRef.current = null;
    },
    [],
  );

  useEffect(() => {
    lineRangeRef.current = experimental_lineRange;
    columnRef.current = experimental_column ?? null;
    if (attachedRef.current !== null) revealRequestedRange();
  }, [experimental_column, experimental_lineRange, revealRequestedRange]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const monaco = workspaceAnchor().monaco;
    if (monaco === null) return;
    const applied = applyCodeTheme(monaco, codeTheme);
    editorRef.current?.updateOptions({ theme: applied.name });
    setOverflowWidgetsTheme(applied.base);
  }, [codeTheme, status]);

  const isDelegating = status.kind === "delegate";
  const isRefreshing = meta?.refreshing ?? false;

  return (
    <>
      {isDelegating ? <Original /> : null}
      <div
        className={cn(
          "min-h-0 flex-1 flex-col",
          isDelegating ? "hidden" : "flex",
        )}
      >
        {isFilesOpen ? (
          <FileTreePanel
            activePath={meta?.relativePath ?? path}
            background={editorBackground(codeTheme.theme)}
            entries={tree.entries}
            error={tree.error}
            isLoading={tree.isLoading}
            root={tree.root}
            onClose={() => setIsFilesOpen(false)}
            onOpenFile={openTreeEntry}
            truncated={tree.truncated}
          />
        ) : null}
        <FileToolbar
          path={path}
          breadcrumbPath={meta?.relativePath ?? path}
          breadcrumbRef={breadcrumbRef}
          onRevealInFiles={() => setIsFilesOpen(true)}
          indicator={indicatorFor(meta, status)}
          saveConflict={meta?.conflict != null}
          saveDisabled={
            status.kind !== "ready" ||
            isRefreshing ||
            readOnly ||
            meta?.saving === true
          }
          onSave={() => void save()}
          isRefreshing={isRefreshing}
          onRefresh={requestRefresh}
          isFilesOpen={isFilesOpen}
          onToggleFiles={() => setIsFilesOpen((open) => !open)}
        />
        <Notice
          conflictNoticeRef={conflictNoticeRef}
          document={meta}
          isRefreshing={isRefreshing}
          onDiscardCancel={() => setPendingDiscard(false)}
          onDiscardConfirm={() => {
            setPendingDiscard(false);
            if (meta !== null) void reloadDocument(meta.key);
          }}
          onOverwrite={() => {
            if (meta !== null) void overwriteDocument(meta.key);
          }}
          onReload={() => {
            if (meta !== null) void reloadDocument(meta.key);
          }}
          onUndoReload={() => {
            if (meta === null) return;
            undoReload(meta.key);
            editorRef.current?.focus();
          }}
          onDismissRestored={() => {
            if (meta !== null) dismissRestoredDraft(meta.key);
          }}
          pendingDiscard={pendingDiscard}
          status={status}
        />
        <div ref={containerRef} className="min-h-0 flex-1" />
      </div>
    </>
  );
}

function indicatorFor(
  document: DocumentMeta | null,
  status: OpenerStatus,
): SaveIndicator {
  if (status.kind === "error") return "error";
  if (document === null) return "clean";
  if (document.saving) return "saving";
  if (document.conflict !== null || document.saveError !== null) return "error";
  return document.dirty ? "dirty" : "clean";
}

function Notice({
  conflictNoticeRef,
  document,
  isRefreshing,
  onDiscardCancel,
  onDiscardConfirm,
  onDismissRestored,
  onOverwrite,
  onReload,
  onUndoReload,
  pendingDiscard,
  status,
}: {
  conflictNoticeRef: React.RefObject<HTMLDivElement | null>;
  document: DocumentMeta | null;
  isRefreshing: boolean;
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onDismissRestored: () => void;
  onOverwrite: () => void;
  onReload: () => void;
  onUndoReload: () => void;
  pendingDiscard: boolean;
  status: OpenerStatus;
}) {
  if (status.kind === "error") {
    return <NoticeRow tone="error">{status.message}</NoticeRow>;
  }
  if (document === null) return null;
  if (document.conflict !== null) {
    const isRemoved = document.conflict.currentSha256 === null;
    const isRemovedCopy = isRemoved && !document.dirty;
    const message = isRemovedCopy
      ? "This file no longer exists on disk. Showing the last loaded copy."
      : isRemoved
        ? "File was removed on disk, edits not saved."
        : "File changed on disk, edits not saved.";
    return (
      <NoticeRow
        tone="warning"
        compact
        focusRef={conflictNoticeRef}
        label={message}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-2">
          <div className="flex min-w-0 max-w-full items-start gap-2">
            <Icon
              name="AlertTriangle"
              className="mt-1 size-4 shrink-0 text-warning-text"
              aria-hidden
            />
            <span className="min-w-0 text-left leading-6">{message}</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-6">
            <NoticeAction
              disabled={isRefreshing || isRemoved}
              onClick={onReload}
              title="Discard your edits and load the latest saved file"
            >
              Reload
            </NoticeAction>
            <NoticeAction
              disabled={isRefreshing || document.saving}
              onClick={onOverwrite}
              title={
                isRemovedCopy
                  ? "Write this copy back to disk"
                  : "Replace the saved file with your edits"
              }
            >
              {isRemovedCopy ? "Restore" : "Overwrite"}
            </NoticeAction>
          </div>
        </div>
      </NoticeRow>
    );
  }
  if (pendingDiscard) {
    return (
      <NoticeRow tone="neutral">
        Reload from disk and discard your unsaved changes?
        <NoticeAction onClick={onDiscardConfirm}>Discard</NoticeAction>
        <NoticeAction onClick={onDiscardCancel}>Cancel</NoticeAction>
      </NoticeRow>
    );
  }
  if (document.saveError !== null) {
    return <NoticeRow tone="error">{document.saveError}</NoticeRow>;
  }
  if (document.reloaded !== null) {
    return (
      <NoticeRow
        tone="neutral"
        compact
        focusRef={conflictNoticeRef}
        label="Disk version loaded."
      >
        <div className="flex min-w-0 flex-1 items-center justify-between gap-6 @min-[32rem]/file-conflict:justify-start">
          <span>Disk version loaded.</span>
          <NoticeAction disabled={isRefreshing} onClick={onUndoReload}>
            Undo
          </NoticeAction>
        </div>
      </NoticeRow>
    );
  }
  if (document.restoredDraft) {
    return (
      <NoticeRow tone="neutral">
        Restored your unsaved changes.
        <NoticeAction onClick={onDismissRestored}>Dismiss</NoticeAction>
      </NoticeRow>
    );
  }
  if (document.readOnly) {
    return (
      <NoticeRow tone="neutral">
        Read-only: this file is outside the workspace and project.
      </NoticeRow>
    );
  }
  if (document.mixedEol && document.dirty) {
    return (
      <NoticeRow tone="neutral">
        This file mixes line endings. Saving makes them consistent.
      </NoticeRow>
    );
  }
  return null;
}

function NoticeRow({
  children,
  tone,
  compact = false,
  focusRef,
  label,
}: {
  children: React.ReactNode;
  tone: "error" | "warning" | "neutral";
  compact?: boolean;
  focusRef?: React.Ref<HTMLDivElement>;
  label?: string;
}) {
  return (
    <div
      ref={focusRef}
      role="status"
      aria-label={label}
      tabIndex={focusRef ? 0 : undefined}
      className={cn(
        "flex shrink-0 items-center gap-2 px-4 text-xs",
        compact
          ? "@container/file-conflict py-0.5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none [&_button]:min-h-6 [&_button]:shrink-0 [&_button]:whitespace-nowrap"
          : "py-1.5",
        tone === "error"
          ? "bg-destructive/10 text-destructive"
          : tone === "warning"
            ? "bg-warning/10 text-foreground"
            : "bg-surface-recessed text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function NoticeAction({
  children,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="cursor-pointer rounded-sm font-medium underline underline-offset-2 hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}

const MONACO_OPENER_ID = "monaco";

function DocumentWatcher() {
  const rpc = useRpc<typeof rpcContract>();
  useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceRevision,
    getWorkspaceRevision,
  );
  const documents = fingerprintQueryDocuments();
  const inputKey = JSON.stringify(documents);
  const input = useMemo(
    () => ({ documents: JSON.parse(inputKey) as typeof documents }),
    [inputKey],
  );
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "documentFingerprints",
    input,
    enabled: documents.length > 0,
  });
  const fingerprints = query.data?.fingerprints;

  useEffect(() => {
    bindStoreRpc(rpc);
  }, [rpc]);

  useEffect(() => {
    adoptWorkspace();
    const uninstallJournalFlush = installJournalLifecycleFlush();
    return () => {
      uninstallJournalFlush();
      void flushJournal();
    };
  }, []);

  useEffect(() => {
    if (fingerprints !== undefined) applyFingerprints(fingerprints);
  }, [fingerprints]);

  useEffect(() => installGitMarkers(rpc), [rpc]);
  useRealtime(GIT_MARKERS_CHANNEL, invalidateGitMarkers);

  return null;
}

function findResultDocumentKey({
  hostId,
  path,
  root,
}: FindInFilesResult): string | null {
  const absolute = joinHostPath({ rootPath: root, relativePath: path });
  return absolute === null ? null : documentKeyFor(hostId, absolute);
}

function openFindResult(result: FindInFilesResult) {
  const documentKey = findResultDocumentKey(result);
  if (
    documentKey !== null &&
    showInOpenTabFromLastEditor(documentKey, result.line, result.column)
  ) {
    return;
  }
  const target = liveFileTarget(result.source, result, result.path);
  requestFindJumpFocus(result.line, result.column);
  if (
    target === null ||
    !openFileFromLastEditor({
      target,
      location: { kind: "line", line: result.line, column: result.column },
      opener: MONACO_OPENER_ID,
    })
  ) {
    cancelFindJumpFocus();
    toast.error("Could not open this file");
  }
}

function FindInFilesHost() {
  return <FindInFilesOverlay onOpenResult={openFindResult} />;
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: MONACO_OPENER_ID,
    title: "File Editor",
    extensions: CLAIMED_EXTENSIONS,
    component: MonacoFileOpener,
    experimental_closeGuard: workspaceCloseGuard,
  });

  app.slots.experimental_appOverlay({
    id: "monaco-document-watcher",
    component: DocumentWatcher,
  });

  app.slots.experimental_appOverlay({
    id: "monaco-find-in-files",
    component: FindInFilesHost,
  });

  for (const command of EDITOR_COMMANDS) {
    app.commands.register({
      id: command.id,
      title: command.title,
      isAvailable: () => isCommandAvailable(command),
      run: () => runEditorCommand(command),
    });
  }
});
