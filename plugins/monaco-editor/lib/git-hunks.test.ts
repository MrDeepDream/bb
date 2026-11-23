import { describe, expect, it } from "vitest";
import {
  parseGitHunks,
  patchNamesPath,
  type GitMarkerRange,
} from "./git-hunks.js";

const HEADER = [
  "diff --git a/file.ts b/file.ts",
  "index 1111111..2222222 100644",
  "--- a/file.ts",
  "+++ b/file.ts",
];

function patchOf(...body: string[]): string {
  return [...HEADER, ...body, ""].join("\n");
}

const range = (
  kind: GitMarkerRange["kind"],
  startLine: number,
  endLine = startLine,
): GitMarkerRange => ({ kind, startLine, endLine });

describe("parseGitHunks", () => {
  it.each<[string, string, number, GitMarkerRange[]]>([
    [
      "added lines between context",
      patchOf("@@ -1,2 +1,4 @@", " a", "+b", "+c", " d"),
      5,
      [range("added", 2, 3)],
    ],
    [
      "replaced lines as modified",
      patchOf("@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"),
      4,
      [range("modified", 2)],
    ],
    [
      "a replacement that grows as one modified range",
      patchOf("@@ -1,3 +1,4 @@", " a", "-b", "+B", "+B2", " c"),
      5,
      [range("modified", 2, 3)],
    ],
    [
      "a pure deletion on the line after it",
      patchOf("@@ -1,3 +1,2 @@", " a", "-b", " c"),
      3,
      [range("deleted", 2)],
    ],
    [
      "a deletion at line 1",
      patchOf("@@ -1,2 +1,1 @@", "-a", " b"),
      2,
      [range("deleted", 1)],
    ],
    [
      "a deletion at end of file with a trailing newline",
      patchOf("@@ -1,3 +1,2 @@", " a", " b", "-c"),
      3,
      [range("deleted", 3)],
    ],
    [
      "a deletion at end of file without a trailing newline",
      patchOf("@@ -1,3 +1,2 @@", " a", " b", "-c"),
      2,
      [range("deleted", 2)],
    ],
    [
      "every line deleted",
      patchOf("@@ -1,2 +0,0 @@", "-a", "-b"),
      1,
      [range("deleted", 1)],
    ],
    [
      "multiple hunks",
      patchOf(
        "@@ -1,2 +1,3 @@",
        " a",
        "+b",
        " c",
        "@@ -10,2 +11,2 @@",
        " j",
        "-k",
        "+K",
      ),
      13,
      [range("added", 2), range("modified", 12)],
    ],
    [
      "mixed blocks in one hunk",
      patchOf("@@ -1,4 +1,4 @@", "+new", " a", "-b", " c", "-d", "+D"),
      5,
      [range("added", 1), range("deleted", 3), range("modified", 4)],
    ],
    [
      "no newline markers inside a replacement",
      patchOf(
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "\\ No newline at end of file",
        "+b",
      ),
      3,
      [range("modified", 2)],
    ],
    [
      "CRLF lines",
      patchOf("@@ -1,2 +1,3 @@ fn\r", " a\r", "+b\r", " c\r"),
      4,
      [range("added", 2)],
    ],
    [
      "content that looks like a file header",
      patchOf("@@ -1,2 +1,2 @@", " a", "--- old", "+++ new"),
      3,
      [range("modified", 2)],
    ],
    [
      "an empty context line",
      patchOf("@@ -1,3 +1,4 @@", " a", "", "+b", " c"),
      5,
      [range("added", 3)],
    ],
    [
      "a rename with edits",
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 90%",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "+B",
        "",
      ].join("\n"),
      3,
      [range("modified", 2)],
    ],
    [
      "a pure rename",
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 100%",
        "rename from old.ts",
        "rename to new.ts",
        "",
      ].join("\n"),
      3,
      [],
    ],
    [
      "an untracked file as all added",
      [
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1,3 @@",
        "+a",
        "+b",
        "+c",
        "",
      ].join("\n"),
      4,
      [range("added", 1, 3)],
    ],
    ["an empty patch", "", 3, []],
  ])("marks %s", (_name, patch, lineCount, expected) => {
    expect(parseGitHunks(patch, lineCount)).toEqual(expected);
  });

  it.each<[string, string, number]>([
    ["a malformed hunk header", patchOf("@@ nonsense @@", "+a"), 3],
    ["a hunk cut short", patchOf("@@ -1,3 +1,3 @@", " a"), 3],
    ["an unknown body line", patchOf("@@ -1,1 +1,1 @@", "?a"), 3],
    [
      "more additions than the header",
      patchOf("@@ -1,1 +1,1 @@", "+a", "+b"),
      3,
    ],
    ["a combined diff", patchOf("@@@ -1,1 -1,1 +1,2 @@@", "++a"), 3],
    [
      "a binary patch",
      [...HEADER, "GIT binary patch", "literal 3", "abc", ""].join("\n"),
      3,
    ],
    [
      "two file sections",
      [
        ...HEADER,
        "@@ -0,0 +1 @@",
        "+a",
        ...HEADER,
        "@@ -0,0 +1 @@",
        "+b",
        "",
      ].join("\n"),
      3,
    ],
    ["ranges past the model", patchOf("@@ -1,1 +1,3 @@", " a", "+b", "+c"), 2],
    ["a deletion past the model", patchOf("@@ -50,2 +50,1 @@", " a", "-b"), 10],
  ])("yields no markers for %s", (_name, patch, lineCount) => {
    expect(parseGitHunks(patch, lineCount)).toEqual([]);
  });
});

describe("patchNamesPath", () => {
  const named = (oldName: string, newName: string) =>
    `diff --git x y\n--- ${oldName}\n+++ ${newName}\n@@ -1 +1 @@\n-a\n+b\n`;

  it.each([
    ["a modified file", named("a/src/a.ts", "b/src/a.ts"), "src/a.ts"],
    ["an added file", named("/dev/null", "b/src/a.ts"), "src/a.ts"],
    ["a deleted file", named("a/src/a.ts", "/dev/null"), "src/a.ts"],
    ["a renamed file", named("a/old.ts", "b/new.ts"), "new.ts"],
    ["a name with a space", named("a/my a.ts\t", "b/my a.ts\t"), "my a.ts"],
    [
      "a quoted non-ASCII name",
      named('"a/caf\\303\\251.ts"', '"b/caf\\303\\251.ts"'),
      "café.ts",
    ],
    [
      "a quoted name with escapes",
      named('"a/x\\ty\\".ts"', '"b/x\\ty\\".ts"'),
      'x\ty".ts',
    ],
  ])("accepts %s", (_name, patch, path) => {
    expect(patchNamesPath(patch, path)).toBe(true);
  });

  it.each([
    ["another file", named("a/b.ts", "b/b.ts"), "a.ts"],
    ["a nested same-named file", named("a/x/a.ts", "b/x/a.ts"), "a.ts"],
    ["a deleted other file", named("a/b.ts", "/dev/null"), "a.ts"],
    ["a rename's old name", named("a/old.ts", "b/new.ts"), "old.ts"],
    ["a patch with no file headers", "diff --git a/a.ts b/a.ts\n", "a.ts"],
    [
      "a header-like line inside a hunk",
      "diff --git x y\n@@ -1 +1 @@\n--- a/a.ts\n+++ b/a.ts\n",
      "a.ts",
    ],
  ])("refuses %s", (_name, patch, path) => {
    expect(patchNamesPath(patch, path)).toBe(false);
  });
});
