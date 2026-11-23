import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";

export type FindInFilesFile = {
  path: string;
  source: PluginFileOpenerSource;
};

export type FindInFilesQuery = {
  query: string;
  mode: "literal" | "regex";
  caseSensitive: boolean;
};

type FindInFilesState = {
  file: FindInFilesFile | null;
  generation: number;
};

const listeners = new Set<() => void>();
let state: FindInFilesState = { file: null, generation: 0 };
let pendingJumpFocus: { line: number; column: number } | null = null;
let rememberedQuery: FindInFilesQuery = {
  query: "",
  mode: "literal",
  caseSensitive: false,
};

function notify() {
  for (const listener of listeners) listener();
}

export function openFindInFiles(file: FindInFilesFile): void {
  state = { file, generation: state.generation + 1 };
  notify();
}

export function closeFindInFiles(): void {
  if (state.file === null) return;
  state = { file: null, generation: state.generation };
  notify();
}

export function requestFindJumpFocus(line: number, column: number): void {
  pendingJumpFocus = { line, column };
}

export function cancelFindJumpFocus(): void {
  pendingJumpFocus = null;
}

export function takeFindJumpFocus(
  line: number,
  column: number | null,
): boolean {
  if (pendingJumpFocus?.line !== line || pendingJumpFocus.column !== column) {
    return false;
  }
  pendingJumpFocus = null;
  return true;
}

export function subscribeFindInFiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFindInFilesState(): FindInFilesState {
  return state;
}

export function getRememberedFindQuery(): FindInFilesQuery {
  return rememberedQuery;
}

export function rememberFindQuery(query: FindInFilesQuery): void {
  rememberedQuery = query;
}
