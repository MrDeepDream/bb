import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRpc, type PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { isImeComposing, isNonImeKey } from "@/lib/ime-keyboard";
import { observeSharedResize } from "@/lib/shared-resize-observer";
import { cn } from "@/lib/utils";
import { focusActiveEditor } from "../lib/editor-commands.js";
import {
  cancelFindJumpFocus,
  closeFindInFiles,
  getFindInFilesState,
  getRememberedFindQuery,
  rememberFindQuery,
  subscribeFindInFiles,
  type FindInFilesFile,
  type FindInFilesQuery,
} from "../lib/find-in-files-state.js";
import {
  DEFAULT_SEARCH_MATCHES,
  MAX_SEARCH_QUERY_CHARS,
  type SearchPage,
} from "../lib/host-contract.js";
import type { rpcContract } from "../lib/rpc-contract.js";

const ROW_HEIGHT_PX = 24;
const OVERSCAN_ROWS = 8;
const SEARCH_DEBOUNCE_MS = 200;

export type FindInFilesResult = {
  source: PluginFileOpenerSource;
  root: string;
  hostId: string;
  environmentId: string | null;
  path: string;
  line: number;
  column: number;
};

type FileRow = { kind: "file"; path: string; count: number };

type MatchRow = {
  kind: "match";
  path: string;
  line: number;
  column: number;
  matchStart: number;
  text: string;
  position: number;
};

type ResultRow = FileRow | MatchRow;

type SearchTarget = Pick<
  FindInFilesResult,
  "root" | "hostId" | "environmentId"
>;

type ResultStore = {
  rows: ResultRow[];
  header: FileRow | null;
  matches: number;
  files: number;
  target: SearchTarget | null;
  highlightLength: number;
};

type SearchPhase =
  | "idle"
  | "searching"
  | "done"
  | "cancelled"
  | "expired"
  | "unavailable"
  | "error";

type SearchView = {
  phase: SearchPhase;
  message: string | null;
  matchCount: number;
  fileCount: number;
  rowCount: number;
  truncated: SearchPage["truncated"];
};

const IDLE_VIEW: SearchView = {
  phase: "idle",
  message: null,
  matchCount: 0,
  fileCount: 0,
  rowCount: 0,
  truncated: null,
};

const TRUNCATED_NOTICE: Record<NonNullable<SearchPage["truncated"]>, string> = {
  limit: `Showing the first ${DEFAULT_SEARCH_MATCHES.toLocaleString()} matching lines. Refine the query to see the rest.`,
  bytes: "Stopped because the results grew too large. Refine the query.",
  time: "Stopped at the time limit. Refine the query.",
};

function emptyStore(): ResultStore {
  return {
    rows: [],
    header: null,
    matches: 0,
    files: 0,
    target: null,
    highlightLength: 1,
  };
}

function appendPage(store: ResultStore, page: SearchPage): void {
  for (const file of page.files) {
    if (store.header?.path !== file.path) {
      store.header = { kind: "file", path: file.path, count: 0 };
      store.rows.push(store.header);
      store.files += 1;
    }
    store.header.count += file.matches.length;
    for (const match of file.matches) {
      store.matches += 1;
      store.rows.push({
        kind: "match",
        path: file.path,
        ...match,
        position: store.matches,
      });
    }
  }
}

function nearestMatchRow(
  rows: readonly ResultRow[],
  target: number,
  direction: 1 | -1,
): number {
  const clamped = Math.max(0, Math.min(rows.length - 1, target));
  if (rows[clamped]?.kind === "match") return clamped;
  const ahead = clamped + direction;
  if (rows[ahead]?.kind === "match") return ahead;
  const behind = clamped - direction;
  return rows[behind]?.kind === "match" ? behind : -1;
}

function statusText(view: SearchView): string {
  const counted = `${view.matchCount.toLocaleString()} ${
    view.matchCount === 1 ? "match" : "matches"
  } in ${view.fileCount.toLocaleString()} ${
    view.fileCount === 1 ? "file" : "files"
  }`;
  switch (view.phase) {
    case "idle":
      return "Type to search";
    case "searching":
      return `Searching… ${counted}`;
    case "cancelled":
      return `Cancelled. ${counted}`;
    case "expired":
      return `Search expired. ${counted}`;
    case "unavailable":
      return "No search folder";
    case "error":
      return "Search failed";
    case "done":
      return view.matchCount === 0 ? "No matches" : counted;
  }
}

function ResultRowView({
  row,
  id,
  active,
  matchCount,
  highlightLength,
  onOpen,
}: {
  row: ResultRow;
  id: string;
  active: boolean;
  matchCount: number;
  highlightLength: number;
  onOpen: () => void;
}) {
  if (row.kind === "file") {
    return (
      <div
        role="presentation"
        title={row.path}
        className="flex h-full items-center gap-2 bg-surface-recessed px-3 text-xs font-medium"
      >
        <span className="min-w-0 flex-1 truncate font-mono">{row.path}</span>
        <span className="shrink-0 text-muted-foreground">{row.count}</span>
      </div>
    );
  }
  const before = row.text.slice(0, row.matchStart);
  const matched = row.text.slice(
    row.matchStart,
    row.matchStart + highlightLength,
  );
  const after = row.text.slice(row.matchStart + highlightLength);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-setsize={matchCount}
      aria-posinset={row.position}
      aria-label={`${row.path}, line ${row.line}, column ${row.column}: ${row.text}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className={cn(
        "flex h-full cursor-pointer items-center gap-2 px-3 font-mono text-xs",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <span className="w-14 shrink-0 text-right text-muted-foreground">
        {row.line}:{row.column}
      </span>
      <span className="min-w-0 flex-1 truncate whitespace-pre">
        {before}
        <mark className="rounded-xs bg-warning/30 text-foreground">
          {matched}
        </mark>
        {after}
      </span>
    </div>
  );
}

function FindInFilesBody({
  file,
  generation,
  compact,
  onOpenResult,
}: {
  file: FindInFilesFile | null;
  generation: number;
  compact: boolean;
  onOpenResult: (result: FindInFilesResult) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const baseId = useId();
  const listId = `${baseId}-results`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const storeRef = useRef<ResultStore>(emptyStore());
  const stopRef = useRef<(() => void) | null>(null);
  const flushRef = useRef<(() => void) | null>(null);
  const [form, setForm] = useState<FindInFilesQuery>(getRememberedFindQuery);
  const [view, setView] = useState<SearchView>(IDLE_VIEW);
  const [activeRow, setActiveRow] = useState(-1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const isOpen = file !== null;
  const fileKey = file === null ? null : JSON.stringify(file);
  const { query, mode, caseSensitive } = form;

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [generation, isOpen]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    setViewportHeight(scroller.clientHeight);
    return observeSharedResize(scroller, {
      read: () => scroller.clientHeight,
      write: setViewportHeight,
    });
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  useEffect(() => {
    rememberFindQuery({ query, mode, caseSensitive });
    storeRef.current = emptyStore();
    setActiveRow(-1);
    setScrollTop(0);
    if (scrollerRef.current !== null) scrollerRef.current.scrollTop = 0;
    if (fileKey === null || query.length === 0) {
      setView(IDLE_VIEW);
      return;
    }
    const searchFile = JSON.parse(fileKey) as FindInFilesFile;
    const store = storeRef.current;
    store.highlightLength = mode === "literal" ? query.length : 1;
    let stopped = false;
    let searchId: string | null = null;
    const releaseSession = () => {
      if (searchId === null) return;
      const id = searchId;
      searchId = null;
      void rpc.call("searchCancel", { searchId: id }).catch(() => undefined);
    };
    const publish = (phase: SearchPhase, page?: SearchPage) => {
      setView({
        phase,
        message: page?.error ?? null,
        matchCount: store.matches,
        fileCount: store.files,
        rowCount: store.rows.length,
        truncated: page?.truncated ?? null,
      });
    };
    const begin = async () => {
      flushRef.current = null;
      publish("searching");
      try {
        const started = await rpc.call("searchStart", {
          file: searchFile,
          query,
          mode,
          caseSensitive,
          limit: DEFAULT_SEARCH_MATCHES,
        });
        if (started.kind === "unavailable") {
          if (!stopped) {
            setView({
              ...IDLE_VIEW,
              phase: "unavailable",
              message: started.reason,
            });
          }
          return;
        }
        searchId = started.searchId;
        if (stopped) {
          releaseSession();
          return;
        }
        store.target = {
          root: started.root,
          hostId: started.hostId,
          environmentId: started.environmentId,
        };
        for (;;) {
          const page = await rpc.call("searchNext", {
            searchId: started.searchId,
          });
          if (stopped) return;
          appendPage(store, page);
          if (page.files.length > 0) {
            setActiveRow((current) =>
              current >= 0 ? current : nearestMatchRow(store.rows, 1, 1),
            );
          }
          if (page.status === "running") {
            publish("searching", page);
            continue;
          }
          searchId = null;
          stopRef.current = null;
          publish(
            page.status === "expired"
              ? "expired"
              : page.error === null
                ? "done"
                : "error",
            page,
          );
          return;
        }
      } catch (error) {
        if (stopped) return;
        releaseSession();
        stopRef.current = null;
        setView((current) => ({
          ...current,
          phase: "error",
          message: error instanceof Error ? error.message : "Search failed",
        }));
      }
    };
    const timer = setTimeout(() => void begin(), SEARCH_DEBOUNCE_MS);
    flushRef.current = () => {
      clearTimeout(timer);
      void begin();
    };
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      flushRef.current = null;
      stopRef.current = null;
      releaseSession();
    };
    stopRef.current = () => {
      stop();
      setView((current) => ({ ...current, phase: "cancelled" }));
    };
    return stop;
  }, [caseSensitive, fileKey, generation, mode, query, rpc]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || activeRow < 0) return;
    const headerAbove = storeRef.current.rows[activeRow - 1]?.kind === "file";
    const top = (activeRow - (headerAbove ? 1 : 0)) * ROW_HEIGHT_PX;
    const bottom = (activeRow + 1) * ROW_HEIGHT_PX;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    }
    setScrollTop(scroller.scrollTop);
  }, [activeRow]);

  const close = useCallback(() => {
    closeFindInFiles();
    focusActiveEditor();
  }, []);

  const openRow = (index: number) => {
    const store = storeRef.current;
    const row = store.rows[index];
    if (row?.kind !== "match" || store.target === null || file === null) return;
    setActiveRow(index);
    onOpenResult({
      source: file.source,
      ...store.target,
      path: row.path,
      line: row.line,
      column: row.column,
    });
    if (compact) closeFindInFiles();
  };

  const moveActive = (delta: number) => {
    const { rows } = storeRef.current;
    if (rows.length === 0) return;
    const direction = delta > 0 ? 1 : -1;
    const next = nearestMatchRow(
      rows,
      (activeRow < 0 ? 0 : activeRow) + delta,
      direction,
    );
    if (next >= 0) setActiveRow(next);
  };

  const pageRows = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT_PX) - 1);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    cancelFindJumpFocus();
    if (isImeComposing(event)) return;
    const delta =
      event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowUp"
          ? -1
          : event.key === "PageDown"
            ? pageRows
            : event.key === "PageUp"
              ? -pageRows
              : 0;
    if (delta !== 0) {
      event.preventDefault();
      moveActive(delta);
    } else if (isNonImeKey(event, "Enter")) {
      event.preventDefault();
      if (flushRef.current !== null) flushRef.current();
      else openRow(activeRow);
    }
  };

  const rows = storeRef.current.rows;
  const firstRow = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS,
  );
  const endRow = Math.min(
    view.rowCount,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT_PX) + OVERSCAN_ROWS,
  );
  const visibleRows: number[] = [];
  for (let index = firstRow; index < endRow; index += 1) {
    visibleRows.push(index);
  }
  const rowId = (index: number) => `${baseId}-row-${index}`;
  const notice =
    view.phase === "error" || view.phase === "unavailable"
      ? view.message
      : view.truncated === null
        ? null
        : TRUNCATED_NOTICE[view.truncated];

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (!compact && isNonImeKey(event, "Escape")) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          Find in Files
        </h2>
        {view.phase === "searching" ? (
          <button
            type="button"
            onClick={() => stopRef.current?.()}
            className="cursor-pointer rounded-sm px-1.5 py-0.5 text-xs font-medium underline underline-offset-2 hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close Find in Files"
          onClick={close}
          className="cursor-pointer rounded-sm p-1 hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Icon name="X" className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search text"
          aria-expanded={view.rowCount > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeRow >= 0 ? rowId(activeRow) : undefined}
          value={query}
          maxLength={MAX_SEARCH_QUERY_CHARS}
          spellCheck={false}
          autoComplete="off"
          placeholder={mode === "regex" ? "Regular expression" : "Text"}
          onChange={(event) =>
            setForm((current) => ({ ...current, query: event.target.value }))
          }
          onKeyDown={onInputKeyDown}
          className="h-7 min-w-0 flex-1 rounded-sm border bg-transparent px-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <ToggleButton
          label="Regular expression"
          pressed={mode === "regex"}
          onToggle={() =>
            setForm((current) => ({
              ...current,
              mode: current.mode === "regex" ? "literal" : "regex",
            }))
          }
        >
          .*
        </ToggleButton>
        <ToggleButton
          label="Match case"
          pressed={caseSensitive}
          onToggle={() =>
            setForm((current) => ({
              ...current,
              caseSensitive: !current.caseSensitive,
            }))
          }
        >
          Aa
        </ToggleButton>
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="shrink-0 px-3 pb-1 text-xs text-muted-foreground"
      >
        {statusText(view)}
      </div>
      {notice === null ? null : (
        <div
          className={cn(
            "shrink-0 px-3 py-1 text-xs",
            view.phase === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-warning/10 text-foreground",
          )}
        >
          {notice}
        </div>
      )}
      <div
        ref={scrollerRef}
        onScroll={() => {
          if (frameRef.current !== null) return;
          frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            setScrollTop(scrollerRef.current?.scrollTop ?? 0);
          });
        }}
        className="min-h-0 flex-1 overflow-auto border-t"
      >
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="relative w-full"
          style={{ height: view.rowCount * ROW_HEIGHT_PX }}
        >
          {visibleRows.map((index) => {
            const row = rows[index];
            if (row === undefined) return null;
            return (
              <div
                key={index}
                role="presentation"
                className="absolute inset-x-0"
                style={{
                  top: index * ROW_HEIGHT_PX,
                  height: ROW_HEIGHT_PX,
                }}
              >
                <ResultRowView
                  row={row}
                  id={rowId(index)}
                  active={index === activeRow}
                  matchCount={view.matchCount}
                  highlightLength={storeRef.current.highlightLength}
                  onOpen={() => openRow(index)}
                />
              </div>
            );
          })}
        </div>
      </div>
      <p className="shrink-0 border-t px-3 py-1 text-xs text-muted-foreground">
        Results reflect saved files. Unsaved edits are not searched.
      </p>
    </div>
  );
}

function ToggleButton({
  children,
  label,
  pressed,
  onToggle,
}: {
  children: React.ReactNode;
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onToggle}
      className={cn(
        "h-7 w-7 shrink-0 cursor-pointer rounded-sm font-mono text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        pressed ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      {children}
    </button>
  );
}

export function FindInFilesOverlay({
  onOpenResult,
}: {
  onOpenResult: (result: FindInFilesResult) => void;
}) {
  const { file, generation } = useSyncExternalStore(
    subscribeFindInFiles,
    getFindInFilesState,
    getFindInFilesState,
  );
  const compact = useIsCompactViewport();
  const isOpen = file !== null;
  const body = (
    <FindInFilesBody
      file={file}
      generation={generation}
      compact={compact}
      onOpenResult={onOpenResult}
    />
  );
  if (compact) {
    return (
      <ResponsiveDrawerShell
        open={isOpen}
        srLabel="Find in Files"
        onOpenChange={(next) => {
          if (!next) closeFindInFiles();
        }}
        onAfterCloseAutoFocus={focusActiveEditor}
        contentClassName="h-[80dvh] p-0"
      >
        {body}
      </ResponsiveDrawerShell>
    );
  }
  if (!isOpen) return null;
  return (
    <div
      role="dialog"
      aria-label="Find in Files"
      className="fixed top-14 left-4 z-40 flex h-[min(70dvh,36rem)] w-[min(36rem,calc(100vw-2rem))] flex-col rounded-lg border bg-background shadow-lg"
    >
      {body}
    </div>
  );
}
