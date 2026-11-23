// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";

vi.mock("./draft-journal.js", () => ({
  readDraft: async () => null,
  writeDraft: async () => undefined,
  deleteDraft: async () => undefined,
}));

import {
  installGitMarkers,
  invalidateGitMarkers,
  scheduleGitMarkerRefresh,
} from "./git-markers.js";
import {
  attachEditor,
  detachEditor,
  modelForDocument,
  openDocument,
  workspaceAnchor,
  type DocumentMeta,
} from "./model-store.js";
import { beforeAllWithRealMonaco } from "./monaco-test-env.js";

const source: PluginFileOpenerSource = {
  kind: "workspace",
  threadId: null,
  environmentId: "env_1",
  projectId: null,
};

const CONTENT = "one\ntwo\nthree\n";
const ADDED_LINE_2 = [
  "diff --git a/f b/f",
  "--- a/f",
  "+++ b/f",
  "@@ -1,2 +1,3 @@",
  " one",
  "+two",
  " three",
  "",
].join("\n");
const ADDED_LINE_3 = ADDED_LINE_2.replace(
  " one\n+two\n three",
  " one\n two\n+three",
);

type MarkerCall = (
  method: "gitMarkers",
  input: { documents: { path: string }[] },
) => Promise<{ states: Record<string, unknown> }>;

let monaco: typeof MonacoNs;
let call: Mock<MarkerCall>;
let uninstall: () => void;

function keyOf(name: string): string {
  return `host::/root/${name}`;
}

async function open(name: string, attach = true): Promise<DocumentMeta> {
  const meta = await openDocument({
    monaco,
    file: {
      content: CONTENT,
      hostId: "host",
      sha256: `sha-${name}`,
      absolutePath: `/root/${name}`,
      relativePath: name,
      documentKey: keyOf(name),
      readOnly: false,
      fingerprint: "fp",
    },
    path: name,
    source,
    tabId: `tab-${name}`,
  });
  if (attach) attachEditor(meta.key, `tab-${name}`);
  return meta;
}

function markerLines(meta: DocumentMeta): number[] {
  const model = modelForDocument(meta);
  return (model?.getAllDecorations() ?? [])
    .filter((entry) => entry.options.linesDecorationsClassName != null)
    .map((entry) => entry.range.startLineNumber)
    .sort((first, second) => first - second);
}

function patchFor(patch: string) {
  return async (
    _method: "gitMarkers",
    input: { documents: { path: string }[] },
  ) => ({
    states: Object.fromEntries(
      input.documents.map(({ path }) => [
        keyOf(path),
        { kind: "patch", patch },
      ]),
    ),
  });
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(250);
}

beforeAllWithRealMonaco((loaded) => {
  monaco = loaded;
});

beforeEach(() => {
  vi.useFakeTimers();
  call = vi.fn<MarkerCall>(patchFor(ADDED_LINE_2));
  uninstall = installGitMarkers({ call } as never);
});

afterEach(() => {
  uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
  const anchor = workspaceAnchor();
  for (const meta of anchor.documents.values()) {
    modelForDocument(meta)?.dispose();
  }
  anchor.documents.clear();
  anchor.tabs.clear();
  const scope = globalThis as unknown as Record<symbol, unknown>;
  scope[Symbol.for("bb.monaco-editor.git-markers")] = undefined;
});

describe("git markers", () => {
  it("requests only visible documents and never touches the text", async () => {
    const visible = await open("visible.ts");
    await open("hidden.ts", false);
    const model = modelForDocument(visible);
    const version = model?.getAlternativeVersionId();
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1].documents.map(({ path }) => path)).toEqual([
      "visible.ts",
    ]);
    expect(markerLines(visible)).toEqual([2]);
    expect(model?.getValue()).toBe(CONTENT);
    expect(model?.getAlternativeVersionId()).toBe(version);
    expect(visible.dirty).toBe(false);
  });

  it("makes no Git call when a known revision is shown again", async () => {
    const meta = await open("a.ts");
    await settle();
    detachEditor(meta.key, "tab-a.ts", null);
    attachEditor(meta.key, "tab-a.ts");
    scheduleGitMarkerRefresh();
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(markerLines(meta)).toEqual([2]);
  });

  it("shows one set of markers for two views of a document", async () => {
    const meta = await open("a.ts");
    attachEditor(meta.key, "tab-second");
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(markerLines(meta)).toEqual([2]);
  });

  it("sends nothing while the window is hidden and catches up when shown", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const meta = await open("a.ts");
    await settle();
    expect(call).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await vi.advanceTimersByTimeAsync(5_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(markerLines(meta)).toEqual([2]);
  });

  it("keeps one request in flight and lets the latest answer win", async () => {
    let release: (value: { states: Record<string, unknown> }) => void = () =>
      undefined;
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const meta = await open("a.ts");
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    call.mockImplementation(patchFor(ADDED_LINE_3));
    invalidateGitMarkers();
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    release({
      states: { [meta.key]: { kind: "patch", patch: ADDED_LINE_2 } },
    });
    await settle();
    expect(call).toHaveBeenCalledTimes(2);
    expect(markerLines(meta)).toEqual([3]);
  });

  it("skips a dirty document and restores markers after undo", async () => {
    const meta = await open("a.ts");
    await settle();
    const model = modelForDocument(meta);
    if (model === null) throw new Error("model missing");
    model.pushStackElement();
    model.pushEditOperations(
      [],
      [{ range: new monaco.Range(2, 1, 3, 1), text: "" }],
      () => null,
    );
    model.pushStackElement();
    expect(meta.dirty).toBe(true);
    invalidateGitMarkers();
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    await model.undo();
    expect(meta.dirty).toBe(false);
    await settle();
    expect(markerLines(meta)).toEqual([2]);
  });

  it("clears markers when Git has nothing to show", async () => {
    const meta = await open("a.ts");
    await settle();
    expect(markerLines(meta)).toEqual([2]);
    call.mockImplementation(async () => ({
      states: { [meta.key]: { kind: "unavailable" } },
    }));
    invalidateGitMarkers();
    await settle();
    expect(markerLines(meta)).toEqual([]);
  });

  it("keeps markers through a failed request and retries on the next change", async () => {
    const meta = await open("a.ts");
    await settle();
    call.mockRejectedValueOnce(new Error("offline"));
    invalidateGitMarkers();
    await settle();
    expect(markerLines(meta)).toEqual([2]);
    invalidateGitMarkers();
    await settle();
    expect(call).toHaveBeenCalledTimes(3);
  });
});
