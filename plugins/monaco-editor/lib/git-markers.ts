import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import { parseGitHunks, type GitMarkerRange } from "./git-hunks.js";
import {
  modelForDocument,
  subscribeWorkspace,
  workspaceAnchor,
  type DocumentMeta,
} from "./model-store.js";
import type { GitMarkerState, rpcContract } from "./rpc-contract.js";

type MarkerRpc = Pick<PluginRpcClient<typeof rpcContract>, "call">;
type TextModel = MonacoNs.editor.ITextModel;

type MarkerRecord = {
  stamp: string;
  ranges: readonly GitMarkerRange[];
  decorationIds: string[];
  modelId: string;
  edited: boolean;
};

type MarkerAnchor = { epoch: number; records: Map<string, MarkerRecord> };

type Request = { meta: DocumentMeta; stamp: string; version: number };

type Session = {
  rpc: MarkerRpc;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  rerun: boolean;
  lastFocusRefreshAt: number;
};

const ANCHOR_KEY = Symbol.for("bb.monaco-editor.git-markers");
const STYLE_ID = "bb-plugin-monaco-editor-git-markers";
const REFRESH_DEBOUNCE_MS = 200;
const FOCUS_REFRESH_MIN_MS = 5_000;

const MARKER_STYLES = `
.monaco-editor .margin-view-overlays .bb-git-marker-added {
  box-shadow: inset 3px 0 0 var(--diff-added);
}
.monaco-editor .margin-view-overlays .bb-git-marker-modified {
  background: repeating-linear-gradient(to bottom, var(--warning-text) 0 4px, transparent 4px 6px) left / 3px 100% no-repeat;
}
.monaco-editor .margin-view-overlays .bb-git-marker-deleted::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  border-top: 5px solid var(--diff-removed);
  border-right: 7px solid transparent;
}
`;

const MARKER_OPTIONS = {
  added: {
    linesDecorationsClassName: "bb-git-marker-added",
    linesDecorationsTooltip: "Added since the last commit",
  },
  modified: {
    linesDecorationsClassName: "bb-git-marker-modified",
    linesDecorationsTooltip: "Changed since the last commit",
  },
  deleted: {
    linesDecorationsClassName: "bb-git-marker-deleted",
    linesDecorationsTooltip: "Lines removed here since the last commit",
  },
} as const;

let session: Session | null = null;

function markerAnchor(): MarkerAnchor {
  const scope = globalThis as unknown as Record<symbol, unknown>;
  const existing = scope[ANCHOR_KEY] as MarkerAnchor | undefined;
  if (existing !== undefined) return existing;
  const created: MarkerAnchor = { epoch: 0, records: new Map() };
  scope[ANCHOR_KEY] = created;
  return created;
}

function stampFor(meta: DocumentMeta, epoch: number): string {
  return `${meta.baseSha}:${epoch}`;
}

function canRequest(meta: DocumentMeta): boolean {
  return (
    meta.attachedEditors > 0 &&
    meta.baseSha !== null &&
    !meta.dirty &&
    !meta.saving &&
    !meta.refreshing &&
    meta.conflict === null
  );
}

function decorate(
  monaco: typeof MonacoNs,
  model: TextModel,
  record: MarkerRecord,
): void {
  record.decorationIds = model.deltaDecorations(
    record.modelId === model.id ? record.decorationIds : [],
    record.ranges.map(({ kind, startLine, endLine }) => ({
      range: new monaco.Range(startLine, 1, endLine, 1),
      options: {
        ...MARKER_OPTIONS[kind],
        isWholeLine: true,
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })),
  );
  record.modelId = model.id;
  record.edited = false;
}

function restoreKnownMarkers(): void {
  const { documents, monaco } = workspaceAnchor();
  const { epoch, records } = markerAnchor();
  for (const [key, record] of records) {
    const meta = documents.get(key);
    const model = meta === undefined ? null : modelForDocument(meta);
    if (meta === undefined || model === null) {
      records.delete(key);
    } else if (meta.dirty) {
      record.edited = true;
    } else if (
      monaco !== null &&
      record.stamp === stampFor(meta, epoch) &&
      (record.edited || record.modelId !== model.id)
    ) {
      decorate(monaco, model, record);
    }
  }
}

function applyState(
  { meta, stamp, version }: Request,
  state: GitMarkerState,
): void {
  const anchor = workspaceAnchor();
  const markers = markerAnchor();
  const model = modelForDocument(meta);
  if (
    anchor.monaco === null ||
    model === null ||
    anchor.documents.get(meta.key) !== meta ||
    meta.dirty ||
    stampFor(meta, markers.epoch) !== stamp ||
    model.getAlternativeVersionId() !== version
  ) {
    return;
  }
  const record = markers.records.get(meta.key) ?? {
    stamp,
    ranges: [],
    decorationIds: [],
    modelId: model.id,
    edited: false,
  };
  markers.records.set(meta.key, record);
  record.stamp = stamp;
  if (state.kind === "deferred") return;
  record.ranges =
    state.kind === "patch"
      ? parseGitHunks(state.patch, model.getLineCount())
      : [];
  decorate(anchor.monaco, model, record);
}

function pendingRequests(): Request[] {
  const { epoch, records } = markerAnchor();
  const requests: Request[] = [];
  for (const meta of workspaceAnchor().documents.values()) {
    if (!canRequest(meta)) continue;
    const stamp = stampFor(meta, epoch);
    if (records.get(meta.key)?.stamp === stamp) continue;
    const model = modelForDocument(meta);
    if (model === null) continue;
    requests.push({ meta, stamp, version: model.getAlternativeVersionId() });
  }
  return requests;
}

async function refresh(current: Session): Promise<void> {
  current.timer = null;
  if (current.running) {
    current.rerun = true;
    return;
  }
  if (session !== current || document.visibilityState === "hidden") return;
  const requests = pendingRequests();
  if (requests.length === 0) return;
  current.running = true;
  const result = await current.rpc
    .call("gitMarkers", {
      documents: requests.map(({ meta }) => ({
        path: meta.path,
        source: meta.source,
      })),
    })
    .catch(() => null);
  current.running = false;
  if (session === current) {
    for (const request of requests) {
      applyState(
        request,
        result === null
          ? { kind: "deferred" }
          : (result.states[request.meta.key] ?? { kind: "unavailable" }),
      );
    }
  }
  if (current.rerun) {
    current.rerun = false;
    scheduleGitMarkerRefresh();
  }
}

export function scheduleGitMarkerRefresh(): void {
  const current = session;
  if (current === null || current.timer !== null) return;
  current.timer = setTimeout(() => void refresh(current), REFRESH_DEBOUNCE_MS);
}

export function invalidateGitMarkers(): void {
  markerAnchor().epoch += 1;
  scheduleGitMarkerRefresh();
}

export function installGitMarkers(rpc: MarkerRpc): () => void {
  const style =
    document.getElementById(STYLE_ID) ?? document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = MARKER_STYLES;
  document.head.append(style);

  const current: Session = {
    rpc,
    timer: null,
    running: false,
    rerun: false,
    lastFocusRefreshAt: Date.now(),
  };
  session = current;
  const unsubscribe = subscribeWorkspace(() => {
    restoreKnownMarkers();
    scheduleGitMarkerRefresh();
  });
  const onWindowShown = () => {
    if (document.visibilityState === "hidden") return;
    const now = Date.now();
    if (now - current.lastFocusRefreshAt < FOCUS_REFRESH_MIN_MS) {
      scheduleGitMarkerRefresh();
      return;
    }
    current.lastFocusRefreshAt = now;
    invalidateGitMarkers();
  };
  window.addEventListener("focus", onWindowShown);
  document.addEventListener("visibilitychange", onWindowShown);
  restoreKnownMarkers();
  scheduleGitMarkerRefresh();
  return () => {
    unsubscribe();
    window.removeEventListener("focus", onWindowShown);
    document.removeEventListener("visibilitychange", onWindowShown);
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = null;
    if (session === current) session = null;
  };
}
