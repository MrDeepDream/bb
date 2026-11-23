// @vitest-environment jsdom

import type * as MonacoNs from "monaco-editor";
import { describe, expect, it, vi } from "vitest";
import { installJetbrainsKeymap, jetbrainsKeymapRules } from "./keymap.js";
import { workspaceAnchor } from "./model-store.js";
import { beforeAllWithRealMonaco } from "./monaco-test-env.js";

type KeybindingService = {
  getKeybindings(): readonly {
    command: string | null;
    resolvedKeybinding?: { getLabel(): string | null };
  }[];
};
type MonacoInternals = {
  CommandsRegistry: { getCommand(id: string): unknown };
  IKeybindingService: unknown;
  StandaloneServices: { get(service: unknown): KeybindingService };
};

function loadMonacoInternal(path: string): Promise<unknown> {
  return import(/* @vite-ignore */ `monaco-editor/${path}.js`);
}

describe("JetBrains keymap", () => {
  let monaco: typeof MonacoNs;
  let internals: MonacoInternals;
  const labels = (command: string) =>
    internals.StandaloneServices.get(internals.IKeybindingService)
      .getKeybindings()
      .filter((binding) => binding.command === command)
      .map((binding) => binding.resolvedKeybinding?.getLabel());

  beforeAllWithRealMonaco(async (loaded) => {
    monaco = loaded;
    const [commands, services, keybinding] = await Promise.all([
      loadMonacoInternal("platform/commands/common/commands"),
      loadMonacoInternal("editor/standalone/browser/standaloneServices"),
      loadMonacoInternal("platform/keybinding/common/keybinding"),
      loadMonacoInternal(
        "editor/contrib/linesOperations/browser/linesOperations",
      ),
      loadMonacoInternal("editor/contrib/multicursor/browser/multicursor"),
      loadMonacoInternal("editor/contrib/smartSelect/browser/smartSelect"),
    ]);
    internals = {
      ...(commands as Pick<MonacoInternals, "CommandsRegistry">),
      ...(services as Pick<MonacoInternals, "StandaloneServices">),
      ...(keybinding as Pick<MonacoInternals, "IKeybindingService">),
    };
    monaco.editor.create(document.createElement("div"));
    monaco.editor.addKeybindingRules(jetbrainsKeymapRules(monaco));
  });

  it("names only commands that exist in the installed Monaco", () => {
    const missing = jetbrainsKeymapRules(monaco)
      .map((rule) => rule.command?.replace(/^-/u, "") ?? "")
      .filter((id) => internals.CommandsRegistry.getCommand(id) === undefined);
    expect(missing).toEqual([]);
  });

  it.each([
    ["editor.action.duplicateSelection", "Ctrl+D"],
    ["editor.action.deleteLines", "Ctrl+Y"],
    ["editor.action.smartSelect.expand", "Ctrl+W"],
    ["editor.action.addSelectionToNextFindMatch", "Alt+J"],
    ["editor.action.moveLinesUpAction", "Shift+Alt+UpArrow"],
    ["editor.action.moveLinesDownAction", "Shift+Alt+DownArrow"],
    ["redo", "Ctrl+Shift+Z"],
  ])("binds %s to %s", (command, label) => {
    expect(labels(command)).toContain(label);
  });

  it.each([
    ["editor.action.addSelectionToNextFindMatch", "Ctrl+D"],
    ["redo", "Ctrl+Y"],
    ["editor.action.copyLinesUpAction", "Shift+Alt+UpArrow"],
    ["editor.action.copyLinesDownAction", "Shift+Alt+DownArrow"],
  ])("removes the default %s on %s", (command, label) => {
    expect(labels(command)).not.toContain(label);
  });

  it("installs the global rules once across plugin generations", () => {
    const addKeybindingRules = vi.fn();
    const fake = {
      KeyCode: monaco.KeyCode,
      KeyMod: monaco.KeyMod,
      editor: { addKeybindingRules },
    } as unknown as typeof MonacoNs;
    const anchor = workspaceAnchor();
    anchor.keymapInstalled = false;

    installJetbrainsKeymap(fake);
    installJetbrainsKeymap(fake);

    expect(addKeybindingRules).toHaveBeenCalledTimes(1);
  });
});
