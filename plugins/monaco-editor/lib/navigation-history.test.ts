import { describe, expect, it } from "vitest";
import {
  createNavigationHistory,
  isNavigationJump,
  MAX_HISTORY_ENTRIES,
  recordFileSwitch,
  recordJump,
  stepHistory,
  syncCurrentLocation,
  takePendingLocation,
  type EditorLocation,
  type NavigationHistory,
} from "./navigation-history.js";

function at(documentKey: string, lineNumber = 1, column = 1): EditorLocation {
  return {
    documentKey,
    tabId: `tab-${documentKey}`,
    path: `${documentKey}.ts`,
    absolutePath: `/repo/${documentKey}.ts`,
    source: {
      kind: "workspace",
      threadId: "thread",
      environmentId: "environment",
      projectId: null,
    },
    hostId: "host",
    lineNumber,
    column,
  };
}

function walk(
  history: NavigationHistory,
  delta: -1 | 1,
  current: EditorLocation | null,
): EditorLocation | null {
  return stepHistory(history, delta, current, () => true);
}

describe("navigation history", () => {
  it("adds one entry per file and tracks the position inside it", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a", 1));
    recordFileSwitch(history, at("a", 40, 3));
    recordFileSwitch(history, at("b", 2));

    expect(history.entries.map((entry) => entry.documentKey)).toEqual([
      "a",
      "b",
    ]);
    expect(history.entries[0]).toMatchObject({ lineNumber: 40, column: 3 });
  });

  it("records both ends of a jump and walks back and forward", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a", 1));
    recordJump(history, at("a", 5, 9), at("a", 90, 2));

    expect(walk(history, -1, at("a", 91, 4))).toMatchObject({
      lineNumber: 5,
      column: 9,
    });
    expect(walk(history, -1, null)).toBeNull();
    expect(walk(history, 1, null)).toMatchObject({
      lineNumber: 91,
      column: 4,
    });
    expect(walk(history, 1, null)).toBeNull();
  });

  it("drops forward entries when a new location is recorded", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a"));
    recordFileSwitch(history, at("b"));
    walk(history, -1, null);
    recordFileSwitch(history, at("c"));

    expect(history.entries.map((entry) => entry.documentKey)).toEqual([
      "a",
      "c",
    ]);
  });

  it("stays bounded and keeps the newest locations", () => {
    const history = createNavigationHistory();
    for (let index = 0; index < MAX_HISTORY_ENTRIES + 10; index += 1) {
      recordFileSwitch(history, at(`file-${index}`));
    }

    expect(history.entries).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(history.index).toBe(MAX_HISTORY_ENTRIES - 1);
    expect(history.entries[0]?.documentKey).toBe("file-10");
  });

  it("does not overwrite another file when syncing", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a", 3));
    syncCurrentLocation(history, at("b", 50));

    expect(history.entries[0]).toMatchObject({
      documentKey: "a",
      lineNumber: 3,
    });
  });

  it("returns a pending location for its document and clears a stale one", () => {
    const history = createNavigationHistory();
    history.pending = at("a", 7);
    expect(takePendingLocation(history, "a")).toMatchObject({ lineNumber: 7 });
    expect(history.pending).toBeNull();

    history.pending = at("a", 7);
    expect(takePendingLocation(history, "b")).toBeNull();
    expect(history.pending).toBeNull();
  });

  it("moves to the previous distinct place after the cursor returns to a recorded line", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a", 1, 1));
    recordJump(history, at("a", 1, 1), at("a", 20, 5));
    recordJump(history, at("a", 20, 5), at("a", 3, 5));

    expect(walk(history, -1, at("a", 20, 5))).toMatchObject({
      lineNumber: 1,
      column: 1,
    });
    expect(walk(history, 1, at("a", 1, 1))).toMatchObject({
      lineNumber: 20,
      column: 5,
    });
    expect(walk(history, 1, at("a", 20, 5))).toBeNull();
  });

  it("moves to the next distinct place after the cursor reaches the forward entry", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a", 1, 1));
    recordJump(history, at("a", 1, 1), at("a", 20, 5));
    recordJump(history, at("a", 20, 5), at("a", 40, 2));
    walk(history, -1, at("a", 40, 2));
    walk(history, -1, at("a", 20, 5));

    expect(walk(history, 1, at("a", 20, 5))).toMatchObject({
      lineNumber: 40,
      column: 2,
    });
    expect(walk(history, -1, at("a", 40, 2))).toMatchObject({
      lineNumber: 20,
      column: 5,
    });
  });

  it("returns to where a jump started after the cursor reached an older entry", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a", 1, 1));
    recordJump(history, at("a", 1, 1), at("a", 20, 5));
    recordJump(history, at("a", 20, 5), at("a", 3, 5));
    recordJump(history, at("a", 20, 5), at("a", 60, 1));

    expect(history.entries.map((entry) => entry.lineNumber)).toEqual([
      1, 20, 60,
    ]);
    expect(walk(history, -1, at("a", 60, 1))).toMatchObject({
      lineNumber: 20,
      column: 5,
    });
  });

  it("skips a location it cannot reach and lands on the next one", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a"));
    recordFileSwitch(history, at("closed"));
    recordFileSwitch(history, at("c"));

    const target = stepHistory(
      history,
      -1,
      at("c"),
      (candidate) => candidate.documentKey !== "closed",
    );

    expect(target?.documentKey).toBe("a");
    expect(history.index).toBe(0);
  });

  it("leaves the index alone when no location can be reached", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("closed"));
    recordFileSwitch(history, at("c", 4));
    const visited: string[] = [];

    const target = stepHistory(history, -1, at("c", 4), (candidate) => {
      visited.push(candidate.documentKey);
      return false;
    });

    expect(target).toBeNull();
    expect(visited).toEqual(["closed"]);
    expect(history.index).toBe(1);
  });

  it("points the index at the target while the visit runs", () => {
    const history = createNavigationHistory();
    recordFileSwitch(history, at("a", 1));
    recordJump(history, at("a", 1), at("a", 50));
    let indexDuringVisit = -1;

    stepHistory(history, -1, at("a", 50), () => {
      indexDuringVisit = history.index;
      return true;
    });

    expect(indexDuringVisit).toBe(0);
  });

  it.each([
    { reason: 3, source: "api", line: 40, expected: true },
    { reason: 3, source: "mouse", line: 40, expected: true },
    { reason: 3, source: "keyboard", line: 40, expected: false },
    { reason: 3, source: "api", line: 12, expected: false },
    { reason: 0, source: "api", line: 40, expected: false },
  ])(
    "treats reason $reason from $source to line $line as jump: $expected",
    ({ reason, source, line, expected }) => {
      expect(
        isNavigationJump(
          { reason, source, position: { lineNumber: line } },
          3,
          10,
        ),
      ).toBe(expected);
    },
  );
});
