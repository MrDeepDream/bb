import type * as MonacoNs from "monaco-editor";
import { workspaceAnchor } from "./model-store.js";

type Monaco = typeof MonacoNs;

export function isMacKeymapPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/u.test(navigator.platform)
  );
}

export function jetbrainsKeymapRules({
  KeyCode,
  KeyMod,
}: Pick<Monaco, "KeyCode" | "KeyMod">): MonacoNs.editor.IKeybindingRule[] {
  const ctrlD = KeyMod.CtrlCmd | KeyCode.KeyD;
  const ctrlY = KeyMod.CtrlCmd | KeyCode.KeyY;
  const altShiftUp = KeyMod.Alt | KeyMod.Shift | KeyCode.UpArrow;
  const altShiftDown = KeyMod.Alt | KeyMod.Shift | KeyCode.DownArrow;
  const writable = "editorTextFocus && !editorReadonly";
  return [
    {
      keybinding: ctrlD,
      command: "-editor.action.addSelectionToNextFindMatch",
    },
    { keybinding: ctrlY, command: "-redo" },
    { keybinding: altShiftUp, command: "-editor.action.copyLinesUpAction" },
    { keybinding: altShiftDown, command: "-editor.action.copyLinesDownAction" },
    {
      keybinding: ctrlD,
      command: "editor.action.duplicateSelection",
      when: writable,
    },
    { keybinding: ctrlY, command: "editor.action.deleteLines", when: writable },
    {
      keybinding: KeyMod.CtrlCmd | KeyCode.KeyW,
      command: "editor.action.smartSelect.expand",
      when: "editorFocus",
    },
    {
      keybinding: KeyMod.Alt | KeyCode.KeyJ,
      command: "editor.action.addSelectionToNextFindMatch",
      when: "editorFocus",
    },
    {
      keybinding: altShiftUp,
      command: "editor.action.moveLinesUpAction",
      when: writable,
    },
    {
      keybinding: altShiftDown,
      command: "editor.action.moveLinesDownAction",
      when: writable,
    },
  ];
}

export function installJetbrainsKeymap(monaco: Monaco): void {
  const anchor = workspaceAnchor();
  if (anchor.keymapInstalled || isMacKeymapPlatform()) return;
  anchor.keymapInstalled = true;
  monaco.editor.addKeybindingRules(jetbrainsKeymapRules(monaco));
}
