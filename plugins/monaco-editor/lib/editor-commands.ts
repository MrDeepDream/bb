import { toast } from "sonner";
import {
  experimental_copyToClipboard,
  type ExperimentalFilePreviewOptions,
} from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import {
  openFindInFiles,
  type FindInFilesFile,
} from "./find-in-files-state.js";

type Editor = MonacoNs.editor.IStandaloneCodeEditor;

type OpenFilePreview = (options: ExperimentalFilePreviewOptions) => boolean;

export type ActiveEditor = {
  editor: Editor;
  absolutePath: string;
  relativePath: string;
  searchFile: FindInFilesFile;
  openFile: OpenFilePreview;
  showInOpenTab: ShowInOpenTab;
  walkHistory: (delta: -1 | 1) => void;
  focusBreadcrumbs: () => void;
};

type ShowInOpenTab = (
  documentKey: string,
  lineNumber: number,
  column: number,
) => boolean;

let lastFocused: ActiveEditor | null = null;
let lastOpenFile: OpenFilePreview | null = null;
let lastShowInOpenTab: ShowInOpenTab | null = null;

export function markEditorActive(active: ActiveEditor): void {
  lastFocused = active;
  lastOpenFile = active.openFile;
  lastShowInOpenTab = active.showInOpenTab;
}

export function openFileFromLastEditor(
  options: ExperimentalFilePreviewOptions,
): boolean {
  return lastOpenFile?.(options) ?? false;
}

export function showInOpenTabFromLastEditor(
  documentKey: string,
  lineNumber: number,
  column: number,
): boolean {
  return lastShowInOpenTab?.(documentKey, lineNumber, column) ?? false;
}

export function focusActiveEditor(): void {
  targetEditor()?.editor.focus();
}

export function forgetEditor(editor: Editor): void {
  if (lastFocused?.editor === editor) lastFocused = null;
}

function targetEditor(): ActiveEditor | null {
  const node = lastFocused?.editor.getDomNode();
  if (!node || !node.isConnected || node.offsetParent === null) return null;
  return lastFocused;
}

function hasMultiLineSelection({ editor }: ActiveEditor): boolean {
  return (
    editor
      .getSelections()
      ?.some(
        (selection) =>
          !selection.isEmpty() &&
          selection.startLineNumber !== selection.endLineNumber,
      ) ?? false
  );
}

export type EditorCommand = {
  id: string;
  title: string;
  precondition?: (active: ActiveEditor) => boolean;
  run: (active: ActiveEditor) => void | Promise<void>;
};

function monacoAction(
  id: string,
  title: string,
  actionId: string,
  precondition?: (active: ActiveEditor) => boolean,
): EditorCommand {
  return {
    id,
    title,
    precondition,
    run: async ({ editor }) => {
      editor.focus();
      await editor.getAction(actionId)?.run();
    },
  };
}

export async function copy(
  text: string,
  successMessage: string,
): Promise<void> {
  if (await experimental_copyToClipboard({ text })) {
    toast.success(successMessage);
  } else {
    toast.error("Failed to copy");
  }
}

export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  ...[1, 2, 3, 4, 5].map((level) =>
    monacoAction(
      `fold-level-${level}`,
      `Monaco: fold level ${level}`,
      `editor.foldLevel${level}`,
    ),
  ),
  monacoAction(
    "fold-recursively",
    "Monaco: fold recursively",
    "editor.foldRecursively",
  ),
  monacoAction("unfold-all", "Monaco: unfold all", "editor.unfoldAll"),
  monacoAction(
    "unfold-recursively",
    "Monaco: unfold recursively",
    "editor.unfoldRecursively",
  ),
  monacoAction("unfold", "Monaco: unfold at cursor", "editor.unfold"),
  monacoAction(
    "sort-lines-ascending",
    "Monaco: sort selected lines ascending",
    "editor.action.sortLinesAscending",
    hasMultiLineSelection,
  ),
  monacoAction(
    "sort-lines-descending",
    "Monaco: sort selected lines descending",
    "editor.action.sortLinesDescending",
    hasMultiLineSelection,
  ),
  {
    id: "copy-path",
    title: "Monaco: copy path of current file",
    run: ({ absolutePath }) => copy(absolutePath, "Absolute path copied"),
  },
  {
    id: "copy-relative-path",
    title: "Monaco: copy relative path of current file",
    run: ({ relativePath }) => copy(relativePath, "Relative path copied"),
  },
  {
    id: "navigate-back",
    title: "Monaco: go back",
    run: ({ walkHistory }) => walkHistory(-1),
  },
  {
    id: "navigate-forward",
    title: "Monaco: go forward",
    run: ({ walkHistory }) => walkHistory(1),
  },
  {
    id: "focus-breadcrumbs",
    title: "Monaco: focus breadcrumbs",
    run: ({ focusBreadcrumbs }) => focusBreadcrumbs(),
  },
  {
    id: "find-in-files",
    title: "Monaco: find in files",
    run: ({ searchFile }) => openFindInFiles(searchFile),
  },
];

export function isCommandAvailable(command: EditorCommand): boolean {
  const active = targetEditor();
  if (!active) return false;
  return command.precondition?.(active) ?? true;
}

export async function runEditorCommand(command: EditorCommand): Promise<void> {
  const active = targetEditor();
  if (!active || !(command.precondition?.(active) ?? true)) return;
  await command.run(active);
}
