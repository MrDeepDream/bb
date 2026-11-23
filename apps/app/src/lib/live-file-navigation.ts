import type { ExperimentalFileLocation } from "@get-bb/plugin-sdk";
export {
  normalizeExperimentalFileOpenOptions,
  normalizeExperimentalFilePreviewOptions,
  normalizeExperimentalLiveFileTarget,
} from "@get-bb/plugin-sdk/internal/file-navigation-validation";
import type { FilePreviewLineRange } from "@bb/client-core";

export function getExperimentalFileLocationStart(
  location: ExperimentalFileLocation | null,
): { columnNumber: number | null; lineNumber: number | null } {
  if (location === null) return { columnNumber: null, lineNumber: null };
  if (location.kind === "line") {
    return { columnNumber: location.column, lineNumber: location.line };
  }
  return { columnNumber: null, lineNumber: location.startLine };
}

const lineRangeColumns = new WeakMap<FilePreviewLineRange, number>();

export function toFilePreviewLineRange(
  location: ExperimentalFileLocation | null,
): FilePreviewLineRange | null {
  if (location === null) return null;
  const lineRange = {
    startLineNumber:
      location.kind === "line" ? location.line : location.startLine,
    endLineNumber: location.kind === "line" ? location.line : location.endLine,
  };
  if (location.kind === "line" && location.column !== null) {
    lineRangeColumns.set(lineRange, location.column);
  }
  return lineRange;
}

export function getFilePreviewLineRangeColumn(
  lineRange: FilePreviewLineRange | null | undefined,
): number | null {
  return lineRange == null ? null : (lineRangeColumns.get(lineRange) ?? null);
}

export function getFileBasename(path: string): string {
  const normalizedPath = path.replace(/[\\/]+$/u, "");
  return normalizedPath.split(/[\\/]/u).at(-1) ?? path;
}
