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

const drafts = vi.hoisted(
  () =>
    new Map<string, { key: string; text: string; baseSha: string | null }>(),
);
const journalGates = vi.hoisted(() => ({
  read: null as Promise<void> | null,
  write: null as Promise<void> | null,
}));
vi.mock("./draft-journal.js", () => ({
  readDraft: async (key: string) => {
    const draft = drafts.get(key) ?? null;
    await journalGates.read;
    return draft;
  },
  writeDraft: async (record: {
    key: string;
    text: string;
    baseSha: string | null;
  }) => {
    const gate = journalGates.write;
    journalGates.write = null;
    await gate;
    drafts.set(record.key, record);
  },
  deleteDraft: async (key: string) => {
    drafts.delete(key);
  },
}));

import {
  adoptWorkspace,
  applyFingerprints,
  attachEditor,
  bindStoreRpc,
  detachEditor,
  dirtyTabs,
  discardDocuments,
  flushJournal,
  modelForDocument,
  openDocument,
  overwriteDocument,
  reloadDocument,
  saveDocument,
  undoReload,
  workspaceAnchor,
  type DocumentMeta,
} from "./model-store.js";
import { beforeAllWithRealMonaco } from "./monaco-test-env.js";
import type { EditorLocation } from "./navigation-history.js";

const source: PluginFileOpenerSource = {
  kind: "workspace",
  threadId: null,
  environmentId: "env_1",
  projectId: null,
};

type DiskFile = {
  kind: "text";
  content: string;
  sha256: string;
  absolutePath: string;
  relativePath: string;
  documentKey: string;
  hostId: string | null;
  readOnly: boolean;
  fingerprint: string | null;
};

let monaco: typeof MonacoNs;
let disk: Map<string, DiskFile>;
let write: Mock<(input: unknown) => Promise<unknown>>;

function diskFile(
  name: string,
  content: string,
  sha256 = `sha-${name}`,
): DiskFile {
  const file: DiskFile = {
    kind: "text",
    content,
    sha256,
    absolutePath: `/root/${name}`,
    relativePath: name,
    documentKey: `host::/root/${name}`,
    hostId: "host",
    readOnly: false,
    fingerprint: `fp-${sha256}`,
  };
  disk.set(name, file);
  return file;
}

async function open(name: string, content: string, tabId = `tab-${name}`) {
  const file = diskFile(name, content);
  return openDocument({ monaco, file, path: name, source, tabId });
}

function typeInto(meta: DocumentMeta, text: string, lineNumber = 1) {
  const model = modelForDocument(meta);
  if (model === null) throw new Error("model is gone");
  model.pushEditOperations(
    [],
    [
      {
        range: {
          startLineNumber: lineNumber,
          startColumn: 1,
          endLineNumber: lineNumber,
          endColumn: 1,
        },
        text,
      },
    ],
    () => null,
  );
  return model;
}

beforeAllWithRealMonaco((loaded) => {
  monaco = loaded;
});

beforeEach(() => {
  drafts.clear();
  journalGates.read = null;
  journalGates.write = null;
  disk = new Map();
  write = vi.fn(async (_input: unknown): Promise<unknown> => ({
    outcome: "written",
    sha256: "saved",
  }));
  bindStoreRpc({
    call: (async (method: string, input: { path: string }) => {
      if (method === "write") return write(input);
      const file = disk.get(input.path);
      if (file === undefined) throw new Error("missing");
      return file;
    }) as never,
  });
});

afterEach(() => {
  const anchor = workspaceAnchor();
  for (const meta of anchor.documents.values()) {
    modelForDocument(meta)?.dispose();
  }
  anchor.documents.clear();
  anchor.tabs.clear();
  anchor.pendingJournal.clear();
});

describe("saving", () => {
  it("stays dirty when typing lands during a save", async () => {
    const meta = await open("typing.ts", "base");
    const model = typeInto(meta, "first ");
    let finish = (_value: unknown) => {};
    write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = saveDocument(meta.key);
    typeInto(meta, "second ");
    finish({ outcome: "written", sha256: "after-first" });
    await expect(saving).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "first base",
        expectedSha256: "sha-typing.ts",
      }),
    );
    expect(meta.dirty).toBe(true);
    expect(meta.baseSha).toBe("after-first");
    expect(model.getValue()).toBe("second first base");
    await saveDocument(meta.key);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "second first base",
        expectedSha256: "after-first",
      }),
    );
    expect(meta.dirty).toBe(false);
  });

  it("sends each document's own sha after a tab moves to another path", async () => {
    const first = await open("first.ts", "one", "shared-tab");
    const second = await open("second.ts", "two", "shared-tab");
    typeInto(first, "a");
    typeInto(second, "b");
    await saveDocument(second.key);
    await saveDocument(first.key);
    expect(write).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        path: "second.ts",
        expectedSha256: "sha-second.ts",
      }),
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: "first.ts",
        expectedSha256: "sha-first.ts",
      }),
    );
  });

  it.each([
    ["BOM with CRLF", "﻿one\r\ntwo\r\n", "x﻿"],
    ["BOM with LF", "﻿one\ntwo\n", "x﻿"],
    ["CRLF", "one\r\ntwo\r\n", "x"],
    ["LF", "one\ntwo\n", "x"],
  ])("round-trips %s through an edit", async (_name, content) => {
    const meta = await open("eol.txt", content);
    expect(modelForDocument(meta)?.getValue(undefined, true)).toBe(content);
    typeInto(meta, "x", 2);
    await saveDocument(meta.key);
    const hasBom = content.startsWith("﻿");
    const body = hasBom ? content.slice(1) : content;
    const eol = body.includes("\r\n") ? "\r\n" : "\n";
    const expected = `${hasBom ? "﻿" : ""}one${eol}xtwo${eol}`;
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ content: expected }),
    );
  });

  it("refuses a read-only document without calling write", async () => {
    const file = diskFile("outside.ts", "text");
    const meta = await openDocument({
      monaco,
      file: { ...file, readOnly: true },
      path: "outside.ts",
      source,
      tabId: "tab-outside",
    });
    typeInto(meta, "x");
    await expect(saveDocument(meta.key)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("external changes", () => {
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("treats its own write event as no change", async () => {
    const meta = await open("own.ts", "text");
    const model = typeInto(meta, "x");
    write.mockResolvedValueOnce({ outcome: "written", sha256: "own-sha" });
    await saveDocument(meta.key);
    diskFile("own.ts", "xtext", "own-sha");
    const version = model.getVersionId();
    applyFingerprints({ [meta.key]: "fp-after-write" });
    await settle();
    expect(model.getVersionId()).toBe(version);
    expect(meta.conflict).toBeNull();
    expect(meta.dirty).toBe(false);
    expect(meta.fingerprint).toBe("fp-after-write");
  });

  it("refreshes a clean document and keeps the cursor on its line", async () => {
    const meta = await open("clean.ts", "one\ntwo\nthree\n");
    const model = modelForDocument(meta);
    if (model === null) throw new Error("model is gone");
    const host = document.createElement("div");
    const editor = monaco.editor.create(host, { model });
    attachEditor(meta.key, "tab-clean.ts");
    editor.setPosition({ lineNumber: 3, column: 3 });
    diskFile("clean.ts", "zero\none\ntwo\nthree\n", "external");
    applyFingerprints({ [meta.key]: "fp-external" });
    await settle();
    expect(model.getValue()).toBe("zero\none\ntwo\nthree\n");
    expect(editor.getPosition()).toMatchObject({ lineNumber: 4, column: 3 });
    expect(meta.dirty).toBe(false);
    expect(meta.baseSha).toBe("external");
    detachEditor(meta.key, "tab-clean.ts", editor.saveViewState());
    editor.dispose();
  });

  it("flags a dirty document, reloads on request, and undoes the reload", async () => {
    const meta = await open("dirty.ts", "base");
    const model = typeInto(meta, "mine ");
    diskFile("dirty.ts", "theirs", "external");
    applyFingerprints({ [meta.key]: "fp-external" });
    await settle();
    expect(model.getValue()).toBe("mine base");
    expect(meta.conflict).toEqual({ currentSha256: "external" });
    await expect(saveDocument(meta.key)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    await reloadDocument(meta.key);
    expect(model.getValue()).toBe("theirs");
    expect(meta.dirty).toBe(false);
    undoReload(meta.key);
    expect(model.getValue()).toBe("mine base");
    expect(meta.conflict).toEqual({ currentSha256: "external" });
    expect(meta.dirty).toBe(true);
  });

  it.each([
    {
      name: "a clean reload with a newer disk",
      startInConflict: false,
      diskSha: "external",
      conflict: { currentSha256: "external" },
    },
    {
      name: "a clean reload with an unchanged disk",
      startInConflict: false,
      diskSha: "sha-race.ts",
      conflict: null,
    },
    {
      name: "an explicit reload from a conflict",
      startInConflict: true,
      diskSha: "external",
      conflict: { currentSha256: "external" },
    },
  ])(
    "keeps text typed during $name",
    async ({ startInConflict, diskSha, conflict }) => {
      const meta = await open("race.ts", "base");
      if (startInConflict) {
        typeInto(meta, "mine ");
        meta.conflict = { currentSha256: "external" };
      }
      const file = diskFile("race.ts", "theirs", diskSha);
      let finishRead = (_value: unknown) => {};
      bindStoreRpc({
        call: (() =>
          new Promise((resolve) => {
            finishRead = resolve;
          })) as never,
      });
      const reloading = reloadDocument(meta.key);
      const model = typeInto(meta, "typed ");
      const typed = model.getValue();
      finishRead(file);
      await expect(reloading).resolves.toBe(false);
      expect(model.getValue()).toBe(typed);
      expect(meta.dirty).toBe(true);
      expect(meta.conflict).toEqual(conflict);
      expect(meta.reloaded).toBeNull();
    },
  );

  it("overwrites only against the sha the user saw", async () => {
    const meta = await open("over.ts", "base");
    typeInto(meta, "mine ");
    diskFile("over.ts", "theirs", "external");
    applyFingerprints({ [meta.key]: "fp-external" });
    await settle();
    await overwriteDocument(meta.key);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "mine base",
        expectedSha256: "external",
      }),
    );
    expect(meta.conflict).toBeNull();
  });

  it("flags a dirty document whose file was removed", async () => {
    const meta = await open("gone.ts", "base");
    typeInto(meta, "mine ");
    applyFingerprints({ [meta.key]: null });
    await settle();
    expect(meta.conflict).toEqual({ currentSha256: null });
    expect(meta.dirty).toBe(true);
  });

  it("flags a clean document whose file was removed until it returns", async () => {
    const meta = await open("clean-gone.ts", "base");
    applyFingerprints({ [meta.key]: null });
    await settle();
    expect(meta.conflict).toEqual({ currentSha256: null });
    expect(meta.dirty).toBe(false);
    expect(modelForDocument(meta)?.getValue()).toBe("base");
    diskFile("clean-gone.ts", "base");
    applyFingerprints({ [meta.key]: "fp-back" });
    await settle();
    expect(meta.conflict).toBeNull();
    expect(meta.fingerprint).toBe("fp-back");
  });

  it("notices a removal after a save cleared the fingerprint", async () => {
    const meta = await open("saved-gone.ts", "text");
    typeInto(meta, "x");
    write.mockResolvedValueOnce({ outcome: "written", sha256: "saved" });
    await saveDocument(meta.key);
    expect(meta.fingerprint).toBeNull();
    applyFingerprints({ [meta.key]: null });
    await settle();
    expect(meta.conflict).toEqual({ currentSha256: null });
  });

  it("replaces a removed-file conflict that named an older disk version", async () => {
    const meta = await open("moved-on.ts", "base");
    typeInto(meta, "mine ");
    diskFile("moved-on.ts", "theirs", "external");
    applyFingerprints({ [meta.key]: "fp-external" });
    await settle();
    expect(meta.conflict).toEqual({ currentSha256: "external" });
    applyFingerprints({ [meta.key]: null });
    await settle();
    expect(meta.conflict).toEqual({ currentSha256: null });
    expect(modelForDocument(meta)?.getValue()).toBe("mine base");
  });

  it("refreshes a clean cached document from a later read", async () => {
    const meta = await open("reopen.ts", "old");
    const file = diskFile("reopen.ts", "new", "sha-new");
    await openDocument({ monaco, file, path: "b.ts", source, tabId: "tab-b" });
    expect(modelForDocument(meta)?.getValue()).toBe("new");
    expect(meta).toMatchObject({ baseSha: "sha-new", dirty: false });
    expect(meta.conflict).toBeNull();
  });

  it("ignores a read that finished after a newer save", async () => {
    const meta = await open("late-read.ts", "old");
    const staleRead = { ...diskFile("late-read.ts", "old") };
    typeInto(meta, "x");
    write.mockResolvedValueOnce({ outcome: "written", sha256: "saved" });
    await saveDocument(meta.key);
    diskFile("late-read.ts", "xold", "saved");
    await openDocument({
      monaco,
      file: staleRead,
      path: "b.ts",
      source,
      tabId: "tab-b",
    });
    expect(modelForDocument(meta)?.getValue()).toBe("xold");
    expect(meta).toMatchObject({ baseSha: "saved", dirty: false });
    expect(meta.conflict).toBeNull();
  });

  it("keeps unsaved text when a later read finds a newer file", async () => {
    const meta = await open("reopen-dirty.ts", "old");
    typeInto(meta, "mine ");
    const file = diskFile("reopen-dirty.ts", "new", "sha-new");
    await openDocument({ monaco, file, path: "b.ts", source, tabId: "tab-b" });
    expect(modelForDocument(meta)?.getValue()).toBe("mine old");
    expect(meta.dirty).toBe(true);
    expect(meta.conflict).toEqual({ currentSha256: "sha-new" });
  });
});

describe("dirty state follows the model", () => {
  function editModel(model: MonacoNs.editor.ITextModel, text: string) {
    model.pushEditOperations(
      [],
      [{ range: new monaco.Range(1, 1, 1, 1), text }],
      () => null,
    );
    model.pushStackElement();
  }

  function requireModel(meta: DocumentMeta) {
    const model = modelForDocument(meta);
    if (model === null) throw new Error("model is gone");
    return model;
  }

  it("clears on a real undo and returns on redo with no editor attached", async () => {
    const meta = await open("undo.ts", "base");
    const model = requireModel(meta);
    editModel(model, "x");
    expect(meta.dirty).toBe(true);
    await model.undo();
    expect(model.getValue()).toBe("base");
    expect(meta.dirty).toBe(false);
    await model.redo();
    expect(model.getValue()).toBe("xbase");
    expect(meta.dirty).toBe(true);
  });

  it("stays correct for undo and redo across a save with two editors", async () => {
    const meta = await open("shared-undo.ts", "base", "tab-a");
    await open("shared-undo.ts", "base", "tab-b");
    const model = requireModel(meta);
    const hosts = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    const editors = hosts.map((host) => monaco.editor.create(host, { model }));
    attachEditor(meta.key, "tab-a");
    attachEditor(meta.key, "tab-b");
    editors[0]?.executeEdits("test", [
      { range: new monaco.Range(1, 1, 1, 1), text: "x" },
    ]);
    model.pushStackElement();
    expect(meta.dirty).toBe(true);
    await saveDocument(meta.key);
    expect(meta.dirty).toBe(false);
    await model.undo();
    expect(model.getValue()).toBe("base");
    expect(meta.dirty).toBe(true);
    await model.redo();
    expect(model.getValue()).toBe("xbase");
    expect(meta.dirty).toBe(false);
    detachEditor(meta.key, "tab-a", null);
    detachEditor(meta.key, "tab-b", null);
    for (const editor of editors) editor.dispose();
  });

  it("replaces the edit listener left by a previous plugin generation", async () => {
    const meta = await open("generation.ts", "base");
    const model = requireModel(meta);
    const { modelEditListeners } = workspaceAnchor();
    modelEditListeners.get(model)?.listener.dispose();
    const dispose = vi.fn();
    modelEditListeners.set(model, {
      handler: () => undefined,
      listener: { dispose },
    });
    adoptWorkspace();
    expect(dispose).toHaveBeenCalledOnce();
    editModel(model, "x");
    expect(meta.dirty).toBe(true);
  });

  it("keeps the host of documents and history from a previous plugin generation", async () => {
    const meta = await open("adopted.ts", "base");
    const earlierSource = { ...source, experimental_hostId: "earlier-host" };
    meta.source = earlierSource;
    Reflect.deleteProperty(meta, "hostId");
    const entry: EditorLocation = {
      documentKey: meta.key,
      tabId: "tab-adopted.ts",
      path: meta.path,
      absolutePath: meta.absolutePath,
      source: earlierSource,
      hostId: null,
      lineNumber: 1,
      column: 1,
    };
    Reflect.deleteProperty(entry, "hostId");
    const { history } = workspaceAnchor();
    history.entries.push(entry);
    history.index = history.entries.length - 1;
    adoptWorkspace();
    history.entries.pop();
    history.index = history.entries.length - 1;
    expect(meta.hostId).toBe("earlier-host");
    expect(entry.hostId).toBe("earlier-host");
  });
});

describe("discarding a document with several views", () => {
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function holdReads(): (value: unknown) => void {
    let finishRead = (_value: unknown) => {};
    bindStoreRpc({
      call: (() =>
        new Promise((resolve) => {
          finishRead = resolve;
        })) as never,
    });
    return (value) => finishRead(value);
  }

  async function restoredInTwoTabs(name: string) {
    const key = `host::/root/${name}`;
    drafts.set(key, { key, text: "mine", baseSha: `sha-${name}` });
    const meta = await open(name, "base", "tab-a");
    await open(name, "base", "tab-b");
    attachEditor(meta.key, "tab-a");
    attachEditor(meta.key, "tab-b");
    expect(meta).toMatchObject({ dirty: true, restoredDraft: true });
    return meta;
  }

  it.each(["before", "after"])(
    "leaves nothing behind when the reload fails %s the views detach",
    async (order) => {
      const meta = await restoredInTwoTabs(`ghost-${order}.ts`);
      bindStoreRpc({
        call: (async () => {
          throw new Error("offline");
        }) as never,
      });
      discardDocuments([meta.key]);
      if (order === "before") await settle();
      detachEditor(meta.key, "tab-a", null);
      detachEditor(meta.key, "tab-b", null);
      await settle();
      await flushJournal();
      expect(workspaceAnchor().documents.has(meta.key)).toBe(false);
      expect(dirtyTabs().size).toBe(0);
      expect(drafts.has(meta.key)).toBe(false);
    },
  );

  it("stops reporting the tabs as dirty as soon as the draft is discarded", async () => {
    const meta = await restoredInTwoTabs("prompt.ts");
    const finishRead = holdReads();
    discardDocuments([meta.key]);
    expect(dirtyTabs().size).toBe(0);
    finishRead(disk.get("prompt.ts"));
    await settle();
    expect(meta.dirty).toBe(false);
    detachEditor(meta.key, "tab-a", null);
    detachEditor(meta.key, "tab-b", null);
  });

  it("does not write the draft back from a journal flush already running", async () => {
    const other = await open("other-draft.ts", "text");
    const meta = await open("flushed.ts", "base", "tab-a");
    await open("flushed.ts", "base", "tab-b");
    attachEditor(meta.key, "tab-a");
    attachEditor(meta.key, "tab-b");
    typeInto(other, "a");
    typeInto(meta, "mine ");
    let releaseWrite = () => {};
    journalGates.write = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const flushing = flushJournal();
    const finishRead = holdReads();
    discardDocuments([meta.key]);
    releaseWrite();
    await flushing;
    expect(drafts.has(meta.key)).toBe(false);
    finishRead(disk.get("flushed.ts"));
    await settle();
    detachEditor(meta.key, "tab-a", null);
    detachEditor(meta.key, "tab-b", null);
  });

  it("does not restore a draft discarded while its journal read is running", async () => {
    const file = diskFile("late.ts", "base");
    drafts.set(file.documentKey, {
      key: file.documentKey,
      text: "mine",
      baseSha: file.sha256,
    });
    let releaseRead = () => {};
    journalGates.read = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const opening = openDocument({
      monaco,
      file,
      path: "late.ts",
      source,
      tabId: "tab-a",
    });
    journalGates.read = null;
    const meta = await openDocument({
      monaco,
      file,
      path: "late.ts",
      source,
      tabId: "tab-b",
    });
    attachEditor(meta.key, "tab-a");
    attachEditor(meta.key, "tab-b");
    discardDocuments([meta.key]);
    await settle();
    releaseRead();
    await opening;
    expect(modelForDocument(meta)?.getValue()).toBe("base");
    expect(meta).toMatchObject({ dirty: false, restoredDraft: false });
    detachEditor(meta.key, "tab-a", null);
    detachEditor(meta.key, "tab-b", null);
  });

  it("keeps new typing in a view that stays open after the discard", async () => {
    const meta = await open("kept.ts", "base", "tab-a");
    await open("kept.ts", "base", "tab-b");
    attachEditor(meta.key, "tab-a");
    attachEditor(meta.key, "tab-b");
    const model = typeInto(meta, "old ");
    const finishRead = holdReads();
    discardDocuments([meta.key]);
    typeInto(meta, "new ");
    finishRead(disk.get("kept.ts"));
    await settle();
    expect(model.getValue()).toBe("new old base");
    expect(meta.dirty).toBe(true);
    expect([...dirtyTabs().keys()].sort()).toEqual(["tab-a", "tab-b"]);
    await flushJournal();
    expect(drafts.get(meta.key)?.text).toBe("new old base");
    detachEditor(meta.key, "tab-a", null);
    detachEditor(meta.key, "tab-b", null);
  });
});

describe("retention", () => {
  it("never evicts a dirty or attached document", async () => {
    const dirty = await open("dirty.ts", "base");
    typeInto(dirty, "mine ");
    const attached = await open("attached.ts", "base");
    attachEditor(attached.key, "tab-attached.ts");
    for (let index = 0; index < 60; index += 1) {
      await open(`clean-${index}.ts`, "text");
    }
    expect(modelForDocument(dirty)).not.toBeNull();
    expect(modelForDocument(attached)).not.toBeNull();
    expect(workspaceAnchor().documents.has("host::/root/clean-0.ts")).toBe(
      false,
    );
    expect(workspaceAnchor().documents.size).toBeLessThanOrEqual(50);
    detachEditor(attached.key, "tab-attached.ts", null);
  });

  it("lists every tab of a dirty document and drops them on discard", async () => {
    const meta = await open("shared.ts", "base", "tab-a");
    await open("shared.ts", "base", "tab-b");
    typeInto(meta, "x");
    expect([...dirtyTabs().keys()].sort()).toEqual(["tab-a", "tab-b"]);
    discardDocuments([meta.key]);
    expect(dirtyTabs().size).toBe(0);
    expect(workspaceAnchor().documents.has(meta.key)).toBe(false);
  });

  it("keeps unsaved text in the journal and restores it on the next open", async () => {
    const meta = await open("draft.ts", "base");
    typeInto(meta, "mine ");
    await flushJournal();
    expect(drafts.get(meta.key)).toMatchObject({
      text: "mine base",
      baseSha: "sha-draft.ts",
    });
    modelForDocument(meta)?.dispose();
    workspaceAnchor().documents.delete(meta.key);
    const restored = await open("draft.ts", "base");
    expect(modelForDocument(restored)?.getValue()).toBe("mine base");
    expect(restored.dirty).toBe(true);
    expect(restored.restoredDraft).toBe(true);
    expect(restored.conflict).toBeNull();
  });

  it("marks a restored draft as a conflict when the disk moved on", async () => {
    const meta = await open("moved.ts", "base");
    typeInto(meta, "mine ");
    await flushJournal();
    modelForDocument(meta)?.dispose();
    workspaceAnchor().documents.delete(meta.key);
    const file = diskFile("moved.ts", "theirs", "external");
    const restored = await openDocument({
      monaco,
      file,
      path: "moved.ts",
      source,
      tabId: "tab-moved.ts",
    });
    expect(modelForDocument(restored)?.getValue()).toBe("mine base");
    expect(restored.conflict).toEqual({ currentSha256: "external" });
  });
});
