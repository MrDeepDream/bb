import { describe, expect, it } from "vitest";
import {
  createSearchParser,
  isSafeResultPath,
  PREVIEW_MAX_BYTES,
  type SearchRecord,
} from "./search-parser";

function record(
  path: string,
  line: number,
  byteColumn: number,
  text: Buffer | string,
): Buffer {
  return Buffer.concat([
    Buffer.from(`${path}\0${line}\0${byteColumn}\0`),
    Buffer.isBuffer(text) ? text : Buffer.from(text),
    Buffer.from("\n"),
  ]);
}

function parse(...chunks: Buffer[]): SearchRecord[] {
  const records: SearchRecord[] = [];
  const parser = createSearchParser((value) => {
    records.push(value);
    return false;
  });
  for (const chunk of chunks) parser.write(chunk);
  return records;
}

function matchedText(value: SearchRecord, length: number): string {
  return value.text.slice(value.matchStart, value.matchStart + length);
}

describe("createSearchParser", () => {
  it("parses a record split at every byte", () => {
    const bytes = record("src/ключ.ts", 12, 8, "héllo needle 😀 tail");
    const parts = Array.from(bytes, (byte) => Buffer.from([byte]));
    expect(parse(...parts)).toEqual(parse(bytes));
    expect(parse(...parts)[0]).toMatchObject({
      path: "src/ключ.ts",
      line: 12,
      column: 7,
    });
  });

  it.each([
    ["two-byte", "é needle", 4, 3],
    ["three-byte", "你 needle", 5, 3],
    ["surrogate pair", "😀 needle", 6, 4],
  ])("converts a %s prefix to a UTF-16 column", (_name, text, byte, column) => {
    const [value] = parse(record("a.ts", 2, byte, text));
    expect(value?.column).toBe(column);
    expect(text.slice((value?.column ?? 1) - 1)).toBe("needle");
    expect(value && matchedText(value, 6)).toBe("needle");
  });

  it("does not count a UTF-8 BOM on line 1", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const [first] = parse(
      record("a.ts", 1, 4, Buffer.concat([bom, Buffer.from("needle")])),
    );
    expect(first).toMatchObject({ column: 1, matchStart: 0, text: "needle" });
    const [later] = parse(
      record("a.ts", 2, 4, Buffer.concat([bom, Buffer.from("needle")])),
    );
    expect(later?.column).toBe(2);
  });

  it("drops the CR of a CRLF line without moving the column", () => {
    const [value] = parse(record("a.ts", 3, 3, "a needle\r"));
    expect(value).toMatchObject({ column: 3, text: "a needle" });
  });

  it("keeps a NUL inside line text", () => {
    const [value] = parse(record("a.ts", 1, 3, "a\0needle"));
    expect(value?.column).toBe(3);
    expect(value?.text).toBe("a\0needle");
  });

  it("clips a long line around the match and keeps the true column", () => {
    const prefix = "é".repeat(50_000);
    const text = `${prefix}needle${"x".repeat(50_000)}`;
    const byte = Buffer.byteLength(prefix) + 1;
    const bytes = record("min.js", 1, byte, text);
    const chunks = [];
    for (let at = 0; at < bytes.length; at += 4096) {
      chunks.push(bytes.subarray(at, at + 4096));
    }
    const [value] = parse(...chunks);
    expect(value?.column).toBe(prefix.length + 1);
    expect(value?.text.startsWith("…")).toBe(true);
    expect(value?.text.endsWith("…")).toBe(true);
    expect(value?.text).not.toContain("\uFFFD");
    expect(Buffer.byteLength(value?.text ?? "")).toBeLessThanOrEqual(
      PREVIEW_MAX_BYTES + 6,
    );
    expect(value && matchedText(value, 6)).toBe("needle");
  });

  it("does not split a character at the clip end", () => {
    const [value] = parse(record("a.ts", 1, 1, `needle${"😀".repeat(400)}`));
    expect(value?.text).not.toContain("\uFFFD");
    expect(value?.text.endsWith("…")).toBe(true);
  });

  it.each([
    "/etc/passwd",
    "\\windows\\system32",
    "C:/secret.txt",
    "c:secret.txt",
    "../outside.txt",
    "a/../../outside.txt",
    "a\\..\\outside.txt",
    "a/..",
  ])("rejects the hostile path %s", (path) => {
    expect(isSafeResultPath(path)).toBe(false);
    expect(parse(record(path, 1, 1, "needle"))).toEqual([]);
  });

  it("keeps a filename that merely contains dots", () => {
    expect(isSafeResultPath("src/a..b/file..ts")).toBe(true);
  });

  it("continues after a rejected record", () => {
    const values = parse(
      Buffer.concat([
        record("../bad", 1, 1, "needle"),
        record("good.ts", 2, 1, "needle"),
      ]),
    );
    expect(values.map(({ path }) => path)).toEqual(["good.ts"]);
  });

  it("stops at the record the consumer refuses", () => {
    const seen: string[] = [];
    const parser = createSearchParser((value) => {
      seen.push(value.path);
      return true;
    });
    expect(
      parser.write(
        Buffer.concat([record("a", 1, 1, "x"), record("b", 1, 1, "x")]),
      ),
    ).toBe(true);
    expect(seen).toEqual(["a"]);
  });
});
