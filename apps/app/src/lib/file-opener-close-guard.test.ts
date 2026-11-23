// @vitest-environment jsdom
import type { ExperimentalFileOpenerCloseGuard } from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingFileTabClose,
  discardPendingFileTabClose,
  requestFileTabsClose,
  requestPageUnload,
  savePendingFileTabClose,
  setFileOpenerCloseGuards,
  whenNoDirtyFileTabs,
} from "./file-opener-close-guard";

function createGuard(dirtyTabs: Record<string, string>, saved = true) {
  const dirty = new Map(Object.entries(dirtyTabs));
  const listeners = new Set<() => void>();
  const discard = vi.fn<(keys: readonly string[]) => void>();
  const save = vi.fn(async (_keys: readonly string[]) => saved);
  const guard: ExperimentalFileOpenerCloseGuard = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dirty: () => dirty,
    save,
    discard,
  };
  const clear = () => {
    dirty.clear();
    for (const listener of listeners) listener();
  };
  return { guard, discard, save, clear };
}

afterEach(() => {
  cancelPendingFileTabClose();
  setFileOpenerCloseGuards([]);
});

describe("requestFileTabsClose", () => {
  it.each<{
    name: string;
    dirty: Record<string, string>;
    closing: string[];
    panel: string[];
    prompts: string[];
  }>([
    {
      name: "clean tab",
      dirty: {},
      closing: ["a"],
      panel: ["a", "b"],
      prompts: [],
    },
    {
      name: "one of two views",
      dirty: { a: "doc", b: "doc" },
      closing: ["a"],
      panel: ["a", "b"],
      prompts: [],
    },
    {
      name: "last view",
      dirty: { a: "doc" },
      closing: ["a"],
      panel: ["a", "b"],
      prompts: ["doc"],
    },
    {
      name: "both views together",
      dirty: { a: "doc", b: "doc" },
      closing: ["a", "b"],
      panel: ["a", "b"],
      prompts: ["doc"],
    },
    {
      name: "close others keeps a surviving view",
      dirty: { a: "first", b: "first", c: "second" },
      closing: ["b", "c"],
      panel: ["a", "b", "c"],
      prompts: ["second"],
    },
  ])("$name", ({ dirty, closing, panel, prompts }) => {
    const { guard, discard } = createGuard(dirty);
    setFileOpenerCloseGuards([guard]);
    const perform = vi.fn();
    requestFileTabsClose({ tabIds: closing, panelTabIds: panel, perform });
    if (prompts.length === 0) {
      expect(perform).toHaveBeenCalledOnce();
      return;
    }
    expect(perform).not.toHaveBeenCalled();
    discardPendingFileTabClose();
    expect(perform).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(prompts);
  });

  it("keeps the tab open when the user cancels", () => {
    const { guard, discard } = createGuard({ a: "doc" });
    setFileOpenerCloseGuards([guard]);
    const perform = vi.fn();
    requestFileTabsClose({ tabIds: ["a"], panelTabIds: ["a"], perform });
    cancelPendingFileTabClose();
    expect(perform).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("keeps the tab open when saving fails", async () => {
    const { guard, save } = createGuard({ a: "doc" }, false);
    setFileOpenerCloseGuards([guard]);
    const perform = vi.fn();
    requestFileTabsClose({ tabIds: ["a"], panelTabIds: ["a"], perform });
    await savePendingFileTabClose();
    expect(save).toHaveBeenCalledWith(["doc"]);
    expect(perform).not.toHaveBeenCalled();
  });
});

describe("requestPageUnload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.bbDesktop;
  });

  function stubDesktop(approved: boolean) {
    const confirmUnsavedEditorsUnload = vi.fn(async () => approved);
    const setHasUnsavedEditors = vi.fn();
    Object.assign(window, {
      bbDesktop: { confirmUnsavedEditorsUnload, setHasUnsavedEditors },
    });
    return { confirmUnsavedEditorsUnload, setHasUnsavedEditors };
  }

  it("unloads a clean page without asking", () => {
    const { confirmUnsavedEditorsUnload } = stubDesktop(false);
    const unload = vi.fn();
    requestPageUnload(unload);
    expect(unload).toHaveBeenCalledOnce();
    expect(confirmUnsavedEditorsUnload).not.toHaveBeenCalled();
  });

  it.each([
    { approved: true, unloads: 1, stays: 0 },
    { approved: false, unloads: 0, stays: 1 },
  ])(
    "on desktop, approved $approved unloads $unloads times",
    async ({ approved, unloads, stays }) => {
      const { confirmUnsavedEditorsUnload, setHasUnsavedEditors } =
        stubDesktop(approved);
      setFileOpenerCloseGuards([createGuard({ a: "doc" }).guard]);
      expect(setHasUnsavedEditors).toHaveBeenLastCalledWith(true);
      const unload = vi.fn();
      const onStay = vi.fn();
      requestPageUnload(unload, onStay);
      expect(unload).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(unload.mock.calls.length + onStay.mock.calls.length).toBe(1),
      );
      expect(confirmUnsavedEditorsUnload).toHaveBeenCalledOnce();
      expect(unload).toHaveBeenCalledTimes(unloads);
      expect(onStay).toHaveBeenCalledTimes(stays);
    },
  );

  it("keeps the page when the desktop bridge fails", async () => {
    const { confirmUnsavedEditorsUnload } = stubDesktop(true);
    confirmUnsavedEditorsUnload.mockRejectedValueOnce(new Error("gone"));
    setFileOpenerCloseGuards([createGuard({ a: "doc" }).guard]);
    const unload = vi.fn();
    const onStay = vi.fn();
    requestPageUnload(unload, onStay);
    await vi.waitFor(() => expect(onStay).toHaveBeenCalledOnce());
    expect(unload).not.toHaveBeenCalled();
  });

  it("leaves the decision to beforeunload on the web", () => {
    setFileOpenerCloseGuards([createGuard({ a: "doc" }).guard]);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const unload = vi.fn();
    const onStay = vi.fn();
    requestPageUnload(unload, onStay);
    expect(unload).toHaveBeenCalledOnce();
    expect(onStay).toHaveBeenCalledOnce();
    setFileOpenerCloseGuards([]);
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });
});

describe("whenNoDirtyFileTabs", () => {
  it("waits until every tab is clean", () => {
    const { guard, clear } = createGuard({ a: "doc" });
    setFileOpenerCloseGuards([guard]);
    const run = vi.fn();
    whenNoDirtyFileTabs(run);
    expect(run).not.toHaveBeenCalled();
    clear();
    expect(run).toHaveBeenCalledOnce();
  });
});
