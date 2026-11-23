export const PREVIEW_MAX_BYTES = 480;
const PREVIEW_BYTES_BEFORE_MATCH = 120;
const MAX_HEAD_FIELD_BYTES = 32 * 1024;
const NUL = 0;
const LF = 10;
const CR = 13;
const ELLIPSIS = "…";

export type SearchRecord = {
  path: string;
  line: number;
  column: number;
  matchStart: number;
  text: string;
};

type HeadField = "path" | "line" | "column";

export function isSafeResultPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  return !value.split(/[\\/]/u).includes("..");
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function countUtf16Units(bytes: Buffer, start: number, end: number): number {
  let units = 0;
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index] ?? 0;
    if (!isContinuation(byte)) units += byte >= 0xf0 ? 2 : 1;
  }
  return units;
}

function completeUtf8End(bytes: Buffer, start: number, end: number): number {
  let lead = end - 1;
  while (lead >= start && lead > end - 4 && isContinuation(bytes[lead] ?? 0)) {
    lead -= 1;
  }
  if (lead < start) return end;
  const byte = bytes[lead] ?? 0;
  const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return lead + length > end ? lead : end;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createSearchParser(
  onRecord: (record: SearchRecord) => boolean,
) {
  const preview = Buffer.allocUnsafe(PREVIEW_MAX_BYTES);
  const firstBytes = [0, 0, 0];
  let field: HeadField | "text" = "path";
  let headParts: Buffer[] = [];
  let headBytes = 0;
  let dropped = false;
  let path = "";
  let line = 0;
  let matchByte = 0;
  let windowStart = 0;
  let lineBytes = 0;
  let unitsBeforeMatch = 0;

  function appendHead(part: Buffer) {
    headBytes += part.length;
    if (headBytes > MAX_HEAD_FIELD_BYTES) {
      dropped = true;
      headParts = [];
      return;
    }
    if (part.length > 0) headParts.push(part);
  }

  function finishHead() {
    const value = Buffer.concat(headParts).toString("utf8");
    headParts = [];
    headBytes = 0;
    if (field === "path") {
      path = value;
      field = "line";
      return;
    }
    const parsed = parsePositiveInteger(value);
    if (parsed === null) dropped = true;
    if (field === "line") {
      line = parsed ?? 0;
      field = "column";
      return;
    }
    matchByte = (parsed ?? 1) - 1;
    windowStart = Math.max(0, matchByte - PREVIEW_BYTES_BEFORE_MATCH);
    lineBytes = 0;
    unitsBeforeMatch = 0;
    field = "text";
  }

  function consumeText(chunk: Buffer, start: number, end: number) {
    const from = lineBytes;
    const to = from + (end - start);
    for (let index = from; index < 3 && index < to; index += 1) {
      firstBytes[index] = chunk[start + index - from] ?? 0;
    }
    const prefixEnd = Math.min(to, matchByte);
    if (prefixEnd > from) {
      unitsBeforeMatch += countUtf16Units(
        chunk,
        start,
        start + (prefixEnd - from),
      );
    }
    const copyFrom = Math.max(from, windowStart);
    const copyTo = Math.min(to, windowStart + PREVIEW_MAX_BYTES);
    if (copyTo > copyFrom) {
      chunk.copy(
        preview,
        copyFrom - windowStart,
        start + (copyFrom - from),
        start + (copyTo - from),
      );
    }
    lineBytes = to;
  }

  function buildRecord(): SearchRecord {
    const hasBom =
      line === 1 &&
      lineBytes >= 3 &&
      firstBytes[0] === 0xef &&
      firstBytes[1] === 0xbb &&
      firstBytes[2] === 0xbf;
    const column = Math.max(
      1,
      unitsBeforeMatch + 1 - (hasBom && matchByte >= 3 ? 1 : 0),
    );
    const windowEnd = windowStart + PREVIEW_MAX_BYTES;
    const stored = Math.max(0, Math.min(lineBytes, windowEnd) - windowStart);
    let start =
      hasBom && windowStart < 3 ? Math.min(3 - windowStart, stored) : 0;
    if (windowStart > 0) {
      while (start < stored && isContinuation(preview[start] ?? 0)) start += 1;
    }
    const clippedAfter = lineBytes > windowEnd;
    let end = stored;
    if (clippedAfter) end = completeUtf8End(preview, start, end);
    else if (end > start && preview[end - 1] === CR) end -= 1;
    const clippedBefore = windowStart + start > (hasBom ? 3 : 0);
    const body = preview.toString("utf8", start, end);
    const matchOffset = Math.max(start, Math.min(matchByte - windowStart, end));
    const bodyMatchStart = Math.min(
      countUtf16Units(preview, start, matchOffset),
      body.length,
    );
    return {
      path,
      line,
      column,
      matchStart: bodyMatchStart + (clippedBefore ? ELLIPSIS.length : 0),
      text: `${clippedBefore ? ELLIPSIS : ""}${body}${clippedAfter ? ELLIPSIS : ""}`,
    };
  }

  function finishRecord(): boolean {
    field = "path";
    const skip = dropped || !isSafeResultPath(path);
    dropped = false;
    return skip ? false : onRecord(buildRecord());
  }

  return {
    write(chunk: Buffer): boolean {
      let offset = 0;
      while (offset < chunk.length) {
        if (field !== "text") {
          const terminator = chunk.indexOf(NUL, offset);
          const end = terminator === -1 ? chunk.length : terminator;
          appendHead(chunk.subarray(offset, end));
          if (terminator === -1) return false;
          finishHead();
          offset = terminator + 1;
          continue;
        }
        const terminator = chunk.indexOf(LF, offset);
        const end = terminator === -1 ? chunk.length : terminator;
        consumeText(chunk, offset, end);
        if (terminator === -1) return false;
        offset = terminator + 1;
        if (finishRecord()) return true;
      }
      return false;
    },
  };
}
