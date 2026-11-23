// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import { glyphKindForPath } from "./components/FileToolbar.js";
import { beforeAllWithRealMonaco } from "./lib/monaco-test-env.js";

const harness = vi.hoisted(() => ({
  monaco: null as unknown as typeof import("monaco-editor"),
}));
vi.mock("./lib/monaco-loader.js", () => ({
  loadMonaco: async () => harness.monaco,
  overflowWidgetsNode: () => document.body,
  setOverflowWidgetsTheme: vi.fn(),
}));
vi.mock("./lib/monaco-theme.js", () => ({
  applyCodeTheme: () => ({ name: "vs-dark", base: "vs-dark" }),
  editorBackground: () => "black",
}));
vi.mock("./lib/draft-journal.js", () => ({
  readDraft: async () => null,
  writeDraft: async () => undefined,
  deleteDraft: async () => undefined,
}));

const app = await loadPluginApp(() => import("./app"));
const { modelForDocument, workspaceAnchor } =
  await import("./lib/model-store.js");
const { EDITOR_COMMANDS, runEditorCommand } =
  await import("./lib/editor-commands.js");
const registration = app.fileOpeners[0]!;
const Component = registration.component;

const LINE = "x".repeat(41);
const CONTENT = Array.from({ length: 160 }, () => LINE).join("\n");

let tabCounter = 0;
let base: PluginFileOpenerProps;
let create: ReturnType<typeof vi.spyOn>;

function fileFor(path: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "text",
    content: CONTENT,
    sha256: "hash",
    absolutePath: `/fixture/${path}`,
    relativePath: path,
    documentKey: `host::/fixture/${path}`,
    hostId: "host",
    readOnly: false,
    fingerprint: "fp",
    ...overrides,
  };
}

const file = fileFor("target.ts");

function requestedPath(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "path" in input &&
    typeof input.path === "string"
  ) {
    return input.path;
  }
  throw new Error("read needs a path");
}

function assets() {
  return { baseUrl: "/assets", expiresAtMs: 99999 };
}

function mount(
  range: PluginFileOpenerProps["experimental_lineRange"],
  read: () => unknown = () => file,
) {
  return renderSlot(
    registration,
    { ...base, experimental_lineRange: range },
    { rpc: { assets, read } },
  );
}

function renderEditor(rpc: Record<string, unknown>) {
  return renderSlot(registration, base, {
    rpc: { assets, read: () => file, ...rpc },
  });
}

function currentEditor(): MonacoNs.editor.IStandaloneCodeEditor {
  const result = create.mock.results.at(-1);
  if (result === undefined) throw new Error("no editor was created");
  return result.value as MonacoNs.editor.IStandaloneCodeEditor;
}

async function readyEditor() {
  await waitFor(() => {
    expect(create).toHaveBeenCalled();
    expect(currentEditor().getModel()).not.toBeNull();
  });
  return currentEditor();
}

function typeText(editor: MonacoNs.editor.IStandaloneCodeEditor, text: string) {
  act(() => {
    editor.executeEdits("test", [
      {
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        },
        text,
      },
    ]);
  });
}

const range = (startLineNumber: number, endLineNumber = startLineNumber) => ({
  startLineNumber,
  endLineNumber,
});

const selectionFor = (target: ReturnType<typeof range>) => ({
  startLineNumber: target.startLineNumber,
  startColumn: 1,
  endLineNumber: target.endLineNumber,
  endColumn: 42,
});

beforeAllWithRealMonaco((loaded) => {
  harness.monaco = loaded;
});

beforeEach(() => {
  tabCounter += 1;
  base = {
    path: "target.ts",
    source: {
      kind: "workspace",
      environmentId: "env_1",
      projectId: null,
      threadId: null,
    },
    experimental_tabId: `tab-${tabCounter}`,
    Original: () => <div>native</div>,
  };
  create = vi.spyOn(harness.monaco.editor, "create");
});

afterEach(() => {
  cleanup();
  create.mockRestore();
  const anchor = workspaceAnchor();
  for (const meta of anchor.documents.values()) {
    modelForDocument(meta)?.dispose();
  }
  anchor.documents.clear();
  anchor.tabs.clear();
  anchor.pendingJournal.clear();
  anchor.history.entries.length = 0;
  anchor.history.index = -1;
  anchor.history.pending = null;
});

it("saves edits with the toolbar button and prevents duplicate pending saves", async () => {
  let finishSave = (_value: { outcome: "written"; sha256: string }) => {};
  const write = vi.fn(
    () =>
      new Promise<{ outcome: "written"; sha256: string }>((resolve) => {
        finishSave = resolve;
      }),
  );
  renderEditor({ write });
  const editor = await readyEditor();
  typeText(editor, "Edited ");
  expect(write).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(write).toHaveBeenCalledWith({
    path: base.path,
    source: base.source,
    content: `Edited ${CONTENT}`,
    expectedSha256: file.sha256,
  });
  const pendingButton = await screen.findByRole("button", { name: "Saving…" });
  expect(pendingButton.hasAttribute("disabled")).toBe(true);
  fireEvent.click(pendingButton);
  expect(write).toHaveBeenCalledOnce();
  await act(async () => finishSave({ outcome: "written", sha256: "saved" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(false);
});

it("overwrites the conflicted version and requires confirmation for a newer conflict", async () => {
  const write = vi
    .fn()
    .mockResolvedValueOnce({ outcome: "conflict", currentSha256: "external" })
    .mockResolvedValueOnce({ outcome: "conflict", currentSha256: "newer" })
    .mockResolvedValue({ outcome: "written", sha256: "saved" });
  renderEditor({ write });
  const editor = await readyEditor();
  typeText(editor, "Edited ");
  const content = `Edited ${CONTENT}`;
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Overwrite" });
  const saveButton = screen.getByRole("button", { name: "Save" });
  expect(saveButton.getAttribute("aria-disabled")).toBe("true");
  expect(saveButton.getAttribute("aria-description")).toBe(
    "Resolve the file conflict below",
  );
  fireEvent.click(saveButton);
  expect(write).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: "Overwrite" });
  expect(write).toHaveBeenNthCalledWith(2, {
    path: base.path,
    source: base.source,
    content,
    expectedSha256: "external",
  });
  fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Overwrite" })).toBeNull(),
  );
  expect(write).toHaveBeenNthCalledWith(3, {
    path: base.path,
    source: base.source,
    content,
    expectedSha256: "newer",
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(4));
  expect(write).toHaveBeenLastCalledWith({
    path: base.path,
    source: base.source,
    content,
    expectedSha256: "saved",
  });
});

it("undoes a reload without writing and restores conflict protection", async () => {
  const diskFile = fileFor("target.ts", {
    content: "Updated on disk",
    sha256: "disk",
  });
  const read = vi.fn().mockReturnValueOnce(file).mockReturnValue(diskFile);
  const write = vi
    .fn()
    .mockResolvedValueOnce({ outcome: "conflict", currentSha256: "external" })
    .mockResolvedValue({ outcome: "conflict", currentSha256: "newer" });
  renderEditor({ read, write });
  const editor = await readyEditor();
  typeText(editor, "Edited ");
  const edited = `Edited ${CONTENT}`;
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
  const undo = await screen.findByRole("button", { name: "Undo" });
  expect(editor.getValue()).toBe("Updated on disk");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("status", { name: "Disk version loaded." }),
    ),
  );
  fireEvent.click(undo);
  expect(editor.getValue()).toBe(edited);
  expect(write).toHaveBeenCalledOnce();
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(write).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(write).toHaveBeenLastCalledWith({
    path: base.path,
    source: base.source,
    content: edited,
    expectedSha256: "disk",
  });
});

it.each(["edit", "file"])(
  "retires the discarded draft after a new %s",
  async (action) => {
    const read = vi.fn((input: { path: string }) => fileFor(input.path));
    const slot = renderEditor({
      read,
      write: () => ({ outcome: "conflict", currentSha256: "external" }),
    });
    const editor = await readyEditor();
    typeText(editor, "Edited ");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await screen.findByRole("button", { name: "Undo" });
    if (action === "edit") {
      typeText(editor, "New edits ");
    } else {
      slot.lifecycle.rerender(<Component {...base} path="other.ts" />);
      await waitFor(() =>
        expect(read).toHaveBeenCalledWith(
          expect.objectContaining({ path: "other.ts" }),
        ),
      );
    }
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(),
    );
  },
);

it("keeps text and skips the read when a tab remounts", async () => {
  const read = vi.fn(() => file);
  const first = renderEditor({ read });
  const editor = await readyEditor();
  typeText(editor, "Unsaved ");
  first.lifecycle.unmount();
  create.mockClear();
  renderEditor({ read });
  const next = await readyEditor();
  expect(next.getValue()).toBe(`Unsaved ${CONTENT}`);
  expect(read).toHaveBeenCalledOnce();
});

it("opens a file outside its roots read-only and hides nothing else", async () => {
  const write = vi.fn();
  renderEditor({
    read: () => fileFor("target.ts", { readOnly: true }),
    write,
  });
  const editor = await readyEditor();
  await screen.findByText(/Read-only/);
  expect(editor.getOption(harness.monaco.editor.EditorOption.readOnly)).toBe(
    true,
  );
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(true);
});

it("hands binary and oversized files to the native preview", async () => {
  renderEditor({
    read: () => ({ kind: "unsupported", reason: "This file is not text" }),
  });
  await screen.findByText("native");
  expect(create).not.toHaveBeenCalled();
});

it.each([range(80), range(120, 124)])(
  "selects and reveals the initial target %j after loading",
  async (target) => {
    mount(target);
    const editor = await readyEditor();
    await waitFor(() =>
      expect(editor.getSelection()).toMatchObject(selectionFor(target)),
    );
  },
);

it.each([null, undefined])(
  "leaves an untargeted initial open alone (%s)",
  async (target) => {
    mount(target);
    const editor = await readyEditor();
    expect(editor.getPosition()).toMatchObject({ lineNumber: 1, column: 1 });
  },
);

it("navigates changed and repeated targets without recreating the editor", async () => {
  const slot = mount(range(80));
  const editor = await readyEditor();
  await waitFor(() =>
    expect(editor.getSelection()).toMatchObject(selectionFor(range(80))),
  );
  const target = range(120, 124);
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={target} />,
  );
  await waitFor(() =>
    expect(editor.getSelection()).toMatchObject(selectionFor(target)),
  );
  editor.setPosition({ lineNumber: 1, column: 1 });
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={target} />,
  );
  expect(editor.getPosition()).toMatchObject({ lineNumber: 1, column: 1 });
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={{ ...target }} />,
  );
  await waitFor(() =>
    expect(editor.getSelection()).toMatchObject(selectionFor(target)),
  );
  editor.setPosition({ lineNumber: 1, column: 1 });
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={null} />,
  );
  expect(editor.getPosition()).toMatchObject({ lineNumber: 1, column: 1 });
  expect(create).toHaveBeenCalledOnce();
});

it("uses only the latest target when several arrive before the file loads", async () => {
  let resolveRead = (_value: typeof file) => {};
  const pending = new Promise<typeof file>((resolve) => {
    resolveRead = resolve;
  });
  const slot = mount(range(30), () => pending);
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={range(90)} />,
  );
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={range(140)} />,
  );
  await act(async () => resolveRead(file));
  const editor = await readyEditor();
  await waitFor(() =>
    expect(editor.getSelection()).toMatchObject(selectionFor(range(140))),
  );
  expect(create).toHaveBeenCalledOnce();
});

it("clamps a target beyond EOF to the final line", async () => {
  mount(range(200, 220));
  const editor = await readyEditor();
  await waitFor(() =>
    expect(editor.getSelection()).toMatchObject(selectionFor(range(160))),
  );
});

it("does not create or navigate a disposed loading editor", async () => {
  let resolveRead = (_value: typeof file) => {};
  const pending = new Promise<typeof file>((resolve) => {
    resolveRead = resolve;
  });
  const slot = mount(range(80), () => pending);
  slot.lifecycle.unmount();
  await act(async () => resolveRead(file));
  expect(create).not.toHaveBeenCalled();
});

it("does not apply a stale target cleared during loading", async () => {
  let resolveRead = (_value: typeof file) => {};
  const pending = new Promise<typeof file>((resolve) => {
    resolveRead = resolve;
  });
  const slot = mount(range(80), () => pending);
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={null} />,
  );
  await act(async () => resolveRead(file));
  const editor = await readyEditor();
  expect(editor.getPosition()).toMatchObject({ lineNumber: 1, column: 1 });
});

it("records a same-file result jump in back and forward history", async () => {
  const slot = renderSlot(registration, base, {
    rpc: { assets, read: () => file },
  });
  const editor = await readyEditor();
  await waitFor(() =>
    expect(workspaceAnchor().history.entries.at(-1)?.tabId).toBe(
      base.experimental_tabId,
    ),
  );
  slot.lifecycle.rerender(
    <Component
      {...base}
      experimental_lineRange={range(100)}
      experimental_column={5}
    />,
  );
  await waitFor(() =>
    expect(editor.getPosition()).toMatchObject({ lineNumber: 100, column: 5 }),
  );
  const { history } = workspaceAnchor();
  expect(history.entries.slice(-2).map((entry) => entry.lineNumber)).toEqual([
    1, 100,
  ]);
  expect(history.index).toBe(history.entries.length - 1);
});

it("clamps a stale result position to the model", async () => {
  const slot = renderSlot(registration, base, {
    rpc: { assets, read: () => file },
  });
  const editor = await readyEditor();
  slot.lifecycle.rerender(
    <Component
      {...base}
      experimental_lineRange={range(9_999)}
      experimental_column={9_999}
    />,
  );
  await waitFor(() =>
    expect(editor.getPosition()).toMatchObject({
      lineNumber: 160,
      column: LINE.length + 1,
    }),
  );
});

it.each([
  ["C:\\repo\\.json", "code"],
  ["C:\\repo\\notes.md", "doc"],
  ["/home/me/.json", "code"],
  ["/home/me/odd\\.json", "data"],
])("picks the toolbar glyph from the file name of %s", (path, kind) => {
  expect(glyphKindForPath(path)).toBe(kind);
});

it("is clean after a real undo in the attached editor", async () => {
  renderEditor({});
  const editor = await readyEditor();
  const meta = [...workspaceAnchor().documents.values()][0];
  typeText(editor, "x");
  expect(meta?.dirty).toBe(true);
  await act(async () => {
    await editor.getModel()?.undo();
  });
  expect(editor.getValue()).toBe(CONTENT);
  expect(meta?.dirty).toBe(false);
});

it("does not re-read tabs of one document opened with different paths", async () => {
  const shared = fileFor("src/f34.ts", {
    absolutePath: "E:\\repo\\src\\f34.ts",
    documentKey: "host_1::e:/repo/src/f34.ts",
  });
  const read = vi.fn((input: unknown) =>
    requestedPath(input) === "other.ts" ? fileFor("other.ts") : shared,
  );
  const cliTab: PluginFileOpenerProps = {
    ...base,
    path: "src/f34.ts",
    experimental_tabId: `${base.experimental_tabId}-cli`,
  };
  const treeTab: PluginFileOpenerProps = {
    ...base,
    path: "E:\\repo\\src\\f34.ts",
    source: {
      kind: "host",
      environmentId: "env_1",
      projectId: null,
      threadId: "thread_1",
    },
    experimental_tabId: `${base.experimental_tabId}-tree`,
  };
  const show = async (props: PluginFileOpenerProps) => {
    create.mockClear();
    const slot = renderSlot(registration, props, { rpc: { assets, read } });
    await readyEditor();
    return slot;
  };
  (await show(cliTab)).lifecycle.unmount();
  (await show(treeTab)).lifecycle.unmount();
  expect(read).toHaveBeenCalledTimes(2);
  for (let round = 0; round < 3; round += 1) {
    (await show(treeTab)).lifecycle.unmount();
    (await show(cliTab)).lifecycle.unmount();
  }
  expect(read).toHaveBeenCalledTimes(2);

  const moved = await show(treeTab);
  moved.lifecycle.rerender(<Component {...treeTab} path="other.ts" />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: "other.ts" }),
  );
});

describe("history across closed files", () => {
  const hostSource: PluginFileOpenerProps["source"] = {
    kind: "host",
    environmentId: "env_1",
    projectId: null,
    threadId: "thread_1",
  };
  const hostFile = (name: string) =>
    fileFor(name, {
      absolutePath: `/repo/${name}`,
      documentKey: `host_1::/repo/${name}`,
      hostId: "host_1",
    });
  const readHost = (input: unknown) => {
    const path = requestedPath(input);
    return hostFile(path.split("/").at(-1) ?? path);
  };
  const tabFor = (name: string): PluginFileOpenerProps => ({
    ...base,
    path: `/repo/${name}`,
    source: hostSource,
    experimental_tabId: `${base.experimental_tabId}-${name}`,
  });
  const goBack = () =>
    act(async () => {
      const back = EDITOR_COMMANDS.find(({ id }) => id === "navigate-back");
      if (back === undefined) throw new Error("navigate-back is missing");
      await runEditorCommand(back);
    });

  async function closedFileThenCurrent(openFilePreview: () => boolean) {
    create.mockClear();
    const closing = renderSlot(registration, tabFor("f05.ts"), {
      rpc: { assets, read: readHost },
    });
    const closingEditor = await readyEditor();
    await waitFor(() =>
      expect(workspaceAnchor().history.entries).toHaveLength(1),
    );
    closingEditor.setPosition({ lineNumber: 30, column: 4 });
    closing.lifecycle.unmount();
    create.mockClear();
    renderSlot(registration, tabFor("f03.ts"), {
      rpc: { assets, read: readHost },
      openFilePreview,
    });
    const editor = await readyEditor();
    await waitFor(() =>
      expect(workspaceAnchor().history.entries).toHaveLength(2),
    );
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      document.body,
    );
    act(() => editor.focus());
  }

  afterEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockRestore();
  });

  it("reopens a closed tree file with the host the server resolved", async () => {
    const openFilePreview = vi.fn(() => true);
    await closedFileThenCurrent(openFilePreview);
    await goBack();
    expect(openFilePreview).toHaveBeenCalledWith({
      target: { kind: "host", hostId: "host_1", path: "/repo/f05.ts" },
      location: null,
      opener: "monaco",
    });
    const { history } = workspaceAnchor();
    expect(history.index).toBe(0);
    expect(history.pending).toMatchObject({ lineNumber: 30, column: 4 });
  });

  it("keeps the history index when the file cannot be reopened", async () => {
    const openFilePreview = vi.fn(() => false);
    await closedFileThenCurrent(openFilePreview);
    await goBack();
    expect(openFilePreview).toHaveBeenCalledOnce();
    const { history } = workspaceAnchor();
    expect(history.index).toBe(1);
    expect(history.pending).toBeNull();
  });
});

describe("one tab per document", () => {
  const hostSource: PluginFileOpenerProps["source"] = {
    kind: "host",
    environmentId: "env_1",
    projectId: null,
    threadId: "thread_1",
  };
  const hostFile = (name: string) =>
    fileFor(name, {
      absolutePath: `/repo/${name}`,
      documentKey: `host_1::/repo/${name}`,
      hostId: "host_1",
    });
  const readHost = (input: unknown) => {
    const path = requestedPath(input);
    return hostFile(path.split("/").at(-1) ?? path);
  };
  const tabFor = (name: string, view = ""): PluginFileOpenerProps => ({
    ...base,
    path: `/repo/${name}`,
    source: hostSource,
    experimental_tabId: `${base.experimental_tabId}-${name}${view}`,
  });
  const panelFor = (
    tabs: readonly PluginFileOpenerProps[],
    selected: PluginFileOpenerProps,
  ) => ({
    getTabs: () => ({
      open: true,
      selectedKey: selected.experimental_tabId ?? null,
      tabs: tabs.map((tab) => ({
        key: tab.experimental_tabId ?? "",
        title: tab.path,
        status: null,
        closable: true,
        detail: { kind: "file" as const, path: tab.path },
      })),
    }),
    selectTab: vi.fn(() => true),
  });
  const searchRpc = {
    searchStart: () => ({
      kind: "started",
      searchId: "11111111-1111-4111-8111-111111111111:host_1",
      root: "/repo",
      hostId: "host_1",
      environmentId: "env_1",
    }),
    searchNext: () => ({
      status: "done",
      files: [
        {
          path: "f08.ts",
          matches: [{ line: 90, column: 7, matchStart: 6, text: "needle" }],
        },
      ],
      matchCount: 1,
      truncated: null,
      error: null,
    }),
    searchCancel: () => null,
  };

  async function visit(
    tab: PluginFileOpenerProps,
    options: Parameters<typeof renderSlot>[2] = {},
  ) {
    create.mockClear();
    const slot = renderSlot(registration, tab, {
      ...options,
      rpc: { assets, read: readHost },
    });
    return { slot, editor: await readyEditor() };
  }

  async function jumpToMatch(source: PluginFileOpenerProps) {
    const { openFindInFiles } = await import("./lib/find-in-files-state.js");
    const overlay = app.appOverlays.find(
      (slot) => slot.id === "monaco-find-in-files",
    )!;
    renderSlot(overlay, {}, { rpc: searchRpc });
    act(() => openFindInFiles({ path: source.path, source: source.source }));
    const input = await screen.findByRole<HTMLInputElement>("combobox", {
      name: "Search text",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option"));
  }

  afterEach(async () => {
    const { closeFindInFiles } = await import("./lib/find-in-files-state.js");
    closeFindInFiles();
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockRestore();
  });

  it("activates the tab already open for a Find match", async () => {
    const f08 = tabFor("f08.ts");
    const f09 = tabFor("f09.ts");
    const panel = panelFor([f08, f09], f09);
    const openFilePreview = vi.fn(() => true);
    (await visit(f08)).slot.lifecycle.unmount();
    const current = await visit(f09, {
      experimental_panel: panel,
      openFilePreview,
    });
    act(() => current.editor.focus());
    await jumpToMatch(f09);
    expect(openFilePreview).not.toHaveBeenCalled();
    expect(panel.selectTab).toHaveBeenCalledExactlyOnceWith(
      f08.experimental_tabId,
    );
    const { history } = workspaceAnchor();
    expect(history.entries.at(-1)).toMatchObject({
      documentKey: "host_1::/repo/f08.ts",
      lineNumber: 90,
      column: 7,
    });
    expect(history.index).toBe(history.entries.length - 1);
    current.slot.lifecycle.unmount();
    const shown = await visit(f08, { experimental_panel: panel });
    expect(shown.editor.getPosition()).toMatchObject({
      lineNumber: 90,
      column: 7,
    });
    expect(shown.editor.getDomNode()?.contains(document.activeElement)).toBe(
      true,
    );
  });

  it("moves within the current tab when it already shows the match", async () => {
    const f08 = tabFor("f08.ts");
    const panel = panelFor([f08], f08);
    const openFilePreview = vi.fn(() => true);
    const { editor } = await visit(f08, {
      experimental_panel: panel,
      openFilePreview,
    });
    act(() => editor.focus());
    await jumpToMatch(f08);
    await waitFor(() =>
      expect(editor.getPosition()).toMatchObject({ lineNumber: 90, column: 7 }),
    );
    expect(openFilePreview).not.toHaveBeenCalled();
    expect(panel.selectTab).not.toHaveBeenCalled();
    expect(editor.getDomNode()?.contains(document.activeElement)).toBe(true);
  });

  it("prefers the most recently shown of two tabs of a document", async () => {
    const first = tabFor("f08.ts");
    const second = tabFor("f08.ts", "-view-2");
    const f09 = tabFor("f09.ts");
    const panel = panelFor([first, second, f09], f09);
    (await visit(first)).slot.lifecycle.unmount();
    (await visit(second)).slot.lifecycle.unmount();
    (await visit(first)).slot.lifecycle.unmount();
    const current = await visit(f09, {
      experimental_panel: panel,
      openFilePreview: () => true,
    });
    act(() => current.editor.focus());
    await jumpToMatch(f09);
    expect(panel.selectTab).toHaveBeenCalledExactlyOnceWith(
      first.experimental_tabId,
    );
  });

  it("goes back into another open tab of a closed entry's document", async () => {
    const kept = tabFor("f05.ts", "-kept");
    const closing = tabFor("f05.ts");
    const f03 = tabFor("f03.ts");
    const panel = panelFor([kept, f03], f03);
    const openFilePreview = vi.fn(() => true);
    (await visit(kept)).slot.lifecycle.unmount();
    const closed = await visit(closing);
    closed.editor.setPosition({ lineNumber: 30, column: 4 });
    closed.slot.lifecycle.unmount();
    const current = await visit(f03, {
      experimental_panel: panel,
      openFilePreview,
    });
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      document.body,
    );
    act(() => current.editor.focus());
    await act(async () => {
      const back = EDITOR_COMMANDS.find(({ id }) => id === "navigate-back");
      if (back === undefined) throw new Error("navigate-back is missing");
      await runEditorCommand(back);
    });
    expect(openFilePreview).not.toHaveBeenCalled();
    expect(panel.selectTab).toHaveBeenCalledExactlyOnceWith(
      kept.experimental_tabId,
    );
    expect(workspaceAnchor().history.pending).toMatchObject({
      tabId: kept.experimental_tabId,
      lineNumber: 30,
      column: 4,
    });
  });
});

describe("reattaching a cached document", () => {
  const key = "host::/fixture/target.ts";
  const answer = (fingerprint: string | null) =>
    vi.fn(() => ({ fingerprints: { [key]: fingerprint }, rootTags: [] }));

  async function reattach(rpc: Record<string, unknown>) {
    create.mockClear();
    const slot = renderSlot(registration, base, { rpc: { assets, ...rpc } });
    return { slot, editor: await readyEditor() };
  }

  it("checks the disk once and does not read an unchanged file", async () => {
    const read = vi.fn(() => file);
    (await reattach({ read })).slot.lifecycle.unmount();
    const documentFingerprints = answer("fp");
    const { editor } = await reattach({ read, documentFingerprints });
    await waitFor(() => expect(documentFingerprints).toHaveBeenCalledOnce());
    expect(documentFingerprints).toHaveBeenCalledWith({
      documents: [{ path: base.path, source: base.source }],
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(read).toHaveBeenCalledOnce();
    expect(editor.getValue()).toBe(CONTENT);
  });

  it("refreshes a clean file that changed while it was closed", async () => {
    const read = vi.fn(() => file);
    (await reattach({ read })).slot.lifecycle.unmount();
    read.mockReturnValue(
      fileFor("target.ts", {
        content: "fresh\n",
        sha256: "hash-2",
        fingerprint: "fp-new",
      }),
    );
    const { editor } = await reattach({
      read,
      documentFingerprints: answer("fp-new"),
    });
    await waitFor(() => expect(editor.getValue()).toBe("fresh\n"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("says so when a clean file was deleted while it was closed", async () => {
    const notice =
      "This file no longer exists on disk. Showing the last loaded copy.";
    const read = vi.fn(() => file);
    const write = vi.fn(() => ({ outcome: "written", sha256: "hash" }));
    (await reattach({ read })).slot.lifecycle.unmount();
    const { editor } = await reattach({
      read,
      write,
      documentFingerprints: answer(null),
    });
    expect(await screen.findByText(notice)).toBeTruthy();
    expect(editor.getValue()).toBe(CONTENT);
    expect(read).toHaveBeenCalledOnce();
    expect(workspaceAnchor().documents.get(key)?.dirty).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({ content: CONTENT, expectedSha256: null }),
      ),
    );
    await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
  });

  it("keeps unsaved text when the file was deleted while it was closed", async () => {
    const read = vi.fn(() => file);
    const first = await reattach({ read });
    typeText(first.editor, "mine ");
    first.slot.lifecycle.unmount();
    const { editor } = await reattach({
      read,
      documentFingerprints: answer(null),
    });
    expect(
      await screen.findByText("File was removed on disk, edits not saved."),
    ).toBeTruthy();
    expect(editor.getValue()).toBe(`mine ${CONTENT}`);
    expect(workspaceAnchor().documents.get(key)?.dirty).toBe(true);
  });
});

describe("Find in Files jump focus", () => {
  const searchRpc = {
    searchStart: () => ({
      kind: "started",
      searchId: "11111111-1111-4111-8111-111111111111:host",
      root: "/fixture",
      hostId: "host",
      environmentId: "env_1",
    }),
    searchNext: () => ({
      status: "done",
      files: [
        {
          path: "target.ts",
          matches: [{ line: 90, column: 7, matchStart: 6, text: "needle" }],
        },
      ],
      matchCount: 1,
      truncated: null,
      error: null,
    }),
    searchCancel: () => null,
  };

  async function jumpFromResults() {
    const { openFindInFiles } = await import("./lib/find-in-files-state.js");
    const overlay = app.appOverlays.find(
      (slot) => slot.id === "monaco-find-in-files",
    )!;
    const opener = renderSlot(registration, base, {
      rpc: { assets, read: () => file },
      openFilePreview: () => true,
    });
    const editor = await readyEditor();
    act(() => editor.focus());
    const results = renderSlot(overlay, {}, { rpc: searchRpc });
    act(() => openFindInFiles({ path: base.path, source: base.source }));
    const input = await screen.findByRole<HTMLInputElement>("combobox", {
      name: "Search text",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const option = await screen.findByRole("option");
    act(() => input.focus());
    fireEvent.click(option);
    return { editor, input, opener, results };
  }

  function deliverTarget(
    opener: Awaited<ReturnType<typeof jumpFromResults>>["opener"],
  ) {
    act(() => {
      opener.lifecycle.rerender(
        <Component
          {...base}
          experimental_lineRange={range(90)}
          experimental_column={7}
        />,
      );
    });
  }

  afterEach(async () => {
    const { closeFindInFiles } = await import("./lib/find-in-files-state.js");
    closeFindInFiles();
  });

  it("puts the caret in the editor at the match and keeps the results", async () => {
    const { editor, input, opener } = await jumpFromResults();
    deliverTarget(opener);
    await waitFor(() =>
      expect(editor.getPosition()).toMatchObject({ lineNumber: 90, column: 7 }),
    );
    expect(editor.getDomNode()?.contains(document.activeElement)).toBe(true);
    expect(input.value).toBe("needle");
    expect(screen.getByRole("option")).toBeTruthy();
  });

  it("leaves focus in the panel when typing continues before the file opens", async () => {
    const { editor, input, opener } = await jumpFromResults();
    fireEvent.keyDown(input, { key: "a" });
    deliverTarget(opener);
    await waitFor(() =>
      expect(editor.getPosition()).toMatchObject({ lineNumber: 90, column: 7 }),
    );
    expect(document.activeElement).toBe(input);
  });
});

it("windows results with list semantics and cancels on unmount", async () => {
  const { closeFindInFiles, openFindInFiles } =
    await import("./lib/find-in-files-state.js");
  const overlay = app.appOverlays.find(
    (slot) => slot.id === "monaco-find-in-files",
  )!;
  const searchStart = vi.fn(() => ({
    kind: "started",
    searchId: "search:host",
    root: "/fixture",
    hostId: "host",
    environmentId: "env_1",
  }));
  const searchNext = vi
    .fn()
    .mockResolvedValueOnce({
      status: "running",
      files: [
        {
          path: "a.ts",
          matches: Array.from({ length: 500 }, (_, index) => ({
            line: index + 1,
            column: 1,
            matchStart: 0,
            text: "needle",
          })),
        },
      ],
      matchCount: 500,
      truncated: null,
      error: null,
    })
    .mockImplementation(() => new Promise(() => undefined));
  const searchCancel = vi.fn(() => null);
  const rendered = renderSlot(
    overlay,
    {},
    {
      rpc: { searchStart, searchNext, searchCancel },
    },
  );
  act(() => openFindInFiles({ path: base.path, source: base.source }));
  const input = await screen.findByRole("combobox", { name: "Search text" });
  fireEvent.change(input, { target: { value: "needle" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
  const options = screen.getAllByRole("option");
  expect(options.length).toBeLessThan(40);
  expect(options[0]?.getAttribute("aria-setsize")).toBe("500");
  expect(options[0]?.getAttribute("aria-posinset")).toBe("1");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() =>
    expect(
      document
        .getElementById(input.getAttribute("aria-activedescendant") ?? "")
        ?.getAttribute("aria-posinset"),
    ).toBe("2"),
  );
  expect(
    screen.getByText(
      "Results reflect saved files. Unsaved edits are not searched.",
    ),
  ).toBeTruthy();
  rendered.lifecycle.unmount();
  await waitFor(() =>
    expect(searchCancel).toHaveBeenCalledWith({ searchId: "search:host" }),
  );
  closeFindInFiles();
});
