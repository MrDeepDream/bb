export type GitMarkerKind = "added" | "modified" | "deleted";

export type GitMarkerRange = {
  kind: GitMarkerKind;
  startLine: number;
  endLine: number;
};

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

const QUOTED_NAME_PART = /\\([0-7]{3}|[abtnvfr"\\])|([^\\]+)/gu;

const NAME_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

function patchFileName(field: string): string {
  const name = field.endsWith("\t") ? field.slice(0, -1) : field;
  if (!name.startsWith('"') || !name.endsWith('"')) return name;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const [, escape, literal] of name
    .slice(1, -1)
    .matchAll(QUOTED_NAME_PART)) {
    if (literal !== undefined) bytes.push(...encoder.encode(literal));
    else if (escape?.length === 3) bytes.push(Number.parseInt(escape, 8));
    else if (escape !== undefined) bytes.push(NAME_ESCAPES[escape] ?? 0);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function patchNamesPath(patch: string, path: string): boolean {
  let oldName: string | null = null;
  let newName: string | null = null;
  let start = 0;
  while (start < patch.length) {
    const newline = patch.indexOf("\n", start);
    const end = newline === -1 ? patch.length : newline;
    if (patch.startsWith("@@", start)) break;
    if (patch.startsWith("--- ", start)) {
      oldName = patchFileName(patch.slice(start + 4, end));
    } else if (patch.startsWith("+++ ", start)) {
      newName = patchFileName(patch.slice(start + 4, end));
    }
    start = end + 1;
  }
  return newName === "/dev/null"
    ? oldName === `a/${path}`
    : newName === `b/${path}`;
}

export function parseGitHunks(
  patch: string,
  lineCount: number,
): GitMarkerRange[] {
  const lines = patch.split("\n");
  const markers: GitMarkerRange[] = [];
  let sawFile = false;
  let pastModel = false;
  let index = 0;

  const flushBlock = (start: number, removed: number, added: number) => {
    if (added > 0) {
      pastModel ||= start + added - 1 > lineCount;
      markers.push({
        kind: removed > 0 ? "modified" : "added",
        startLine: start,
        endLine: start + added - 1,
      });
    } else if (removed > 0) {
      pastModel ||= start > lineCount + 1;
      const boundary = Math.max(Math.min(start, lineCount), 1);
      markers.push({ kind: "deleted", startLine: boundary, endLine: boundary });
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;
    if (line.startsWith("diff --git ")) {
      if (sawFile) return [];
      sawFile = true;
      continue;
    }
    if (line.startsWith("GIT binary patch")) return [];
    if (!line.startsWith("@@")) continue;

    const header = HUNK_HEADER.exec(line);
    if (header === null) return [];
    let oldLeft = Number(header[1] ?? 1);
    const newStart = Number(header[2]);
    let newLeft = Number(header[3] ?? 1);
    let newLine = newLeft === 0 ? newStart + 1 : newStart;
    let blockStart = newLine;
    let removed = 0;
    let added = 0;

    while (oldLeft > 0 || newLeft > 0) {
      const body = lines[index];
      if (body === undefined) return [];
      index += 1;
      const sign = body[0] ?? " ";
      if (sign === "\\") continue;
      if (sign === "-") {
        if (oldLeft === 0) return [];
        oldLeft -= 1;
        removed += 1;
      } else if (sign === "+") {
        if (newLeft === 0) return [];
        newLeft -= 1;
        added += 1;
        newLine += 1;
      } else if (sign === " ") {
        if (oldLeft === 0 || newLeft === 0) return [];
        flushBlock(blockStart, removed, added);
        removed = 0;
        added = 0;
        oldLeft -= 1;
        newLeft -= 1;
        newLine += 1;
        blockStart = newLine;
      } else {
        return [];
      }
    }
    flushBlock(blockStart, removed, added);
  }

  return pastModel ? [] : markers;
}
