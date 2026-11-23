import { randomUUID } from "node:crypto";
import {
  experimental_runVcsProcess as runVcsProcess,
  experimental_sanitizeInheritedChildProcessEnv as sanitizeInheritedChildProcessEnv,
  experimental_spawnPortableOutputProcess as spawnPortableOutputProcess,
} from "@get-bb/plugin-sdk/host";
import { experimental_killPortableProcess as killPortableProcess } from "@get-bb/plugin-sdk/provider-bridge";
import type { SearchOptions, SearchPage } from "./host-contract.js";
import { createSearchParser, type SearchRecord } from "./search-parser.js";

const PAGE_MAX_BYTES = 1024 * 1024 - 1024;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 500;
const SEARCH_WALL_CLOCK_MS = 60_000;
const SESSION_IDLE_MS = 30_000;
const LONG_POLL_MS = 5_000;
const MAX_LIVE_SESSIONS = 3;
const FORCE_KILL_AFTER_MS = 1_000;
const RECORD_OVERHEAD_BYTES = 64;
const WINDOWS_STARTUP_CRASH_ATTEMPTS = 3;
const WINDOWS_STARTUP_CRASH_RETRY_MS = 150;
const STATUS_DLL_INIT_FAILED = 0xc0000142;

const GIT_GLOBAL_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
];

const REPOSITORY_ENV_KEY =
  /^GIT_(?:ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_PARAMETERS|CONFIG_VALUE_\d+|DIR|GRAFT_FILE|IMPLICIT_WORK_TREE|INDEX_FILE|NAMESPACE|OBJECT_DIRECTORY|PREFIX|SHALLOW_FILE|WORK_TREE)$/iu;

type TruncatedReason = NonNullable<SearchPage["truncated"]>;

type GitOutcome =
  | { kind: "exit"; code: number; stdout: string; stderr: string }
  | { kind: "signal"; signal: string }
  | { kind: "killed" }
  | { kind: "spawn-failed"; message: string };

type BufferedRecord = { record: SearchRecord; bytes: number };

type Session = {
  id: string;
  controller: AbortController;
  pending: BufferedRecord[];
  head: number;
  bufferedBytes: number;
  matchCount: number;
  limit: number;
  finished: boolean;
  truncated: TruncatedReason | null;
  error: string | null;
  waiter: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  wallTimer: ReturnType<typeof setTimeout> | null;
};

function searchGitEnv(): NodeJS.ProcessEnv {
  const inherited = sanitizeInheritedChildProcessEnv({ env: process.env });
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => !REPOSITORY_ENV_KEY.test(key)),
  );
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANGUAGE: "C",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnGitOnce(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onStdout: ((chunk: Buffer) => boolean) | null,
): Promise<GitOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnPortableOutputProcess>;
    try {
      child = spawnPortableOutputProcess({
        command: "git",
        args,
        cwd,
        env: searchGitEnv(),
      });
    } catch (error) {
      resolve({ kind: "spawn-failed", message: errorMessage(error) });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stopping = false;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      if (stopping) return;
      stopping = true;
      killPortableProcess(child, "SIGTERM");
      forceKill = setTimeout(
        () => killPortableProcess(child, "SIGKILL"),
        FORCE_KILL_AFTER_MS,
      );
    };
    const finish = (outcome: GitOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      signal.removeEventListener("abort", stop);
      resolve(outcome);
    };

    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopping) return;
      if (onStdout === null) stdoutChunks.push(chunk);
      else if (onStdout(chunk)) stop();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const kept = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
      stderrBytes += kept.length;
      stderrChunks.push(kept);
    });
    child.on("error", (error) => {
      finish(
        stopping
          ? { kind: "killed" }
          : { kind: "spawn-failed", message: error.message },
      );
    });
    child.on("close", (code, closeSignal) => {
      if (stopping) {
        finish({ kind: "killed" });
      } else if (code === null) {
        finish({ kind: "signal", signal: closeSignal ?? "unknown" });
      } else {
        finish({
          kind: "exit",
          code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      }
    });
  });
}

async function runGitProcess(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onStdout: ((chunk: Buffer) => boolean) | null,
): Promise<GitOutcome> {
  try {
    return await runVcsProcess(
      "git",
      args,
      async () => {
        for (let attempt = 1; ; attempt += 1) {
          const outcome = await spawnGitOnce(args, cwd, signal, onStdout);
          if (
            outcome.kind !== "exit" ||
            outcome.code !== STATUS_DLL_INIT_FAILED ||
            outcome.stderr !== "" ||
            attempt >= WINDOWS_STARTUP_CRASH_ATTEMPTS
          ) {
            return outcome;
          }
          await new Promise((wake) =>
            setTimeout(wake, WINDOWS_STARTUP_CRASH_RETRY_MS * attempt),
          );
        }
      },
      { priority: "interactive", signal },
    );
  } catch (error) {
    return signal.aborted
      ? { kind: "killed" }
      : { kind: "spawn-failed", message: errorMessage(error) };
  }
}

function gitFailure(outcome: GitOutcome): string | null {
  switch (outcome.kind) {
    case "killed":
      return null;
    case "spawn-failed":
      return `Could not run git: ${outcome.message}`;
    case "signal":
      return `git was terminated by ${outcome.signal}`;
    case "exit": {
      if (outcome.code === 0 || outcome.code === 1) return null;
      const detail = outcome.stderr
        .trim()
        .replace(/^fatal:\s*/u, "")
        .slice(0, MAX_ERROR_CHARS);
      return detail === "" ? `git exited with code ${outcome.code}` : detail;
    }
  }
}

export async function isRepositoryRoot(
  rootPath: string,
  signal: AbortSignal,
): Promise<boolean> {
  const outcome = await runGitProcess(
    [...GIT_GLOBAL_ARGS, "rev-parse", "--show-prefix"],
    rootPath,
    signal,
    null,
  );
  if (outcome.kind !== "exit") {
    throw new Error(gitFailure(outcome) ?? "git was stopped");
  }
  return outcome.code === 0 && outcome.stdout.replace(/\r?\n$/u, "") === "";
}

export function grepArgs(
  options: Pick<SearchOptions, "query" | "mode" | "caseSensitive">,
  inRepository: boolean,
): string[] {
  return [
    ...GIT_GLOBAL_ARGS,
    "grep",
    "-n",
    "--column",
    "-z",
    "-I",
    "--no-color",
    "--no-textconv",
    "--no-full-name",
    "--no-recurse-submodules",
    inRepository ? "--untracked" : "--no-index",
    "--exclude-standard",
    options.mode === "regex" ? "-E" : "-F",
    ...(options.caseSensitive ? [] : ["-i"]),
    "-e",
    options.query,
    "--",
  ];
}

export function createSearchSessions() {
  const sessions = new Map<string, Session>();

  function wake(session: Session) {
    const waiter = session.waiter;
    session.waiter = null;
    waiter?.();
  }

  function destroy(session: Session) {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    if (session.wallTimer !== null) clearTimeout(session.wallTimer);
    session.idleTimer = null;
    session.wallTimer = null;
    sessions.delete(session.id);
    session.controller.abort();
    wake(session);
  }

  function touch(session: Session) {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => destroy(session), SESSION_IDLE_MS);
    session.idleTimer.unref?.();
    sessions.delete(session.id);
    sessions.set(session.id, session);
  }

  function finish(session: Session, error: string | null) {
    session.finished = true;
    session.error = error;
    if (session.wallTimer !== null) clearTimeout(session.wallTimer);
    session.wallTimer = null;
    wake(session);
  }

  function acceptRecord(session: Session, record: SearchRecord): boolean {
    if (session.matchCount >= session.limit) {
      session.truncated = "limit";
      return true;
    }
    const bytes =
      Buffer.byteLength(JSON.stringify([record.path, record.text])) +
      RECORD_OVERHEAD_BYTES;
    if (session.bufferedBytes + bytes > MAX_BUFFERED_BYTES) {
      session.truncated = "bytes";
      return true;
    }
    session.pending.push({ record, bytes });
    session.bufferedBytes += bytes;
    session.matchCount += 1;
    return false;
  }

  async function run(
    session: Session,
    options: SearchOptions,
    rootPath: string,
  ) {
    const { signal } = session.controller;
    const probe = await runGitProcess(
      [...GIT_GLOBAL_ARGS, "rev-parse", "--is-inside-work-tree"],
      rootPath,
      signal,
      null,
    );
    if (probe.kind === "killed") {
      finish(session, null);
      return;
    }
    if (probe.kind !== "exit" || (probe.code !== 0 && probe.code !== 128)) {
      finish(session, gitFailure(probe) ?? "Could not inspect the search root");
      return;
    }
    const inRepository = probe.code === 0 && probe.stdout.trim() === "true";
    const parser = createSearchParser((record) =>
      acceptRecord(session, record),
    );
    const outcome = await runGitProcess(
      grepArgs(options, inRepository),
      rootPath,
      signal,
      (chunk) => {
        const stop = parser.write(chunk);
        if (session.head < session.pending.length) wake(session);
        return stop;
      },
    );
    finish(session, gitFailure(outcome));
  }

  function drainPage(session: Session): SearchPage["files"] {
    const files: SearchPage["files"] = [];
    let bytes = 0;
    while (session.head < session.pending.length) {
      const entry = session.pending[session.head];
      if (entry === undefined) break;
      if (files.length > 0 && bytes + entry.bytes > PAGE_MAX_BYTES) break;
      bytes += entry.bytes;
      session.head += 1;
      session.bufferedBytes -= entry.bytes;
      const { path, line, column, matchStart, text } = entry.record;
      let file = files.at(-1);
      if (file?.path !== path) {
        file = { path, matches: [] };
        files.push(file);
      }
      file.matches.push({ line, column, matchStart, text });
    }
    if (session.head >= session.pending.length) {
      session.pending.length = 0;
      session.head = 0;
    }
    return files;
  }

  async function waitForRecords(session: Session, signal: AbortSignal) {
    if (session.head < session.pending.length || session.finished) return;
    wake(session);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (session.waiter === done) session.waiter = null;
        resolve();
      };
      const timer = setTimeout(done, LONG_POLL_MS);
      signal.addEventListener("abort", done, { once: true });
      session.waiter = done;
      if (signal.aborted) done();
    });
  }

  return {
    start(options: SearchOptions & { rootPath: string }): { searchId: string } {
      const { rootPath, ...searchOptions } = options;
      while (sessions.size >= MAX_LIVE_SESSIONS) {
        const oldest = sessions.values().next().value;
        if (oldest === undefined) break;
        destroy(oldest);
      }
      const session: Session = {
        id: randomUUID(),
        controller: new AbortController(),
        pending: [],
        head: 0,
        bufferedBytes: 0,
        matchCount: 0,
        limit: searchOptions.limit,
        finished: false,
        truncated: null,
        error: null,
        waiter: null,
        idleTimer: null,
        wallTimer: null,
      };
      session.wallTimer = setTimeout(() => {
        session.truncated ??= "time";
        session.controller.abort();
      }, SEARCH_WALL_CLOCK_MS);
      session.wallTimer.unref?.();
      touch(session);
      void run(session, searchOptions, rootPath).catch((error: unknown) => {
        finish(session, errorMessage(error));
      });
      return { searchId: session.id };
    },

    async next(searchId: string, signal: AbortSignal): Promise<SearchPage> {
      const session = sessions.get(searchId);
      if (session === undefined) {
        return {
          status: "expired",
          files: [],
          matchCount: 0,
          truncated: null,
          error: null,
        };
      }
      touch(session);
      await waitForRecords(session, signal);
      if (sessions.get(searchId) !== session) {
        return {
          status: "expired",
          files: [],
          matchCount: session.matchCount,
          truncated: session.truncated,
          error: null,
        };
      }
      touch(session);
      const files = drainPage(session);
      const done = session.finished && session.pending.length === 0;
      const page: SearchPage = {
        status: done ? "done" : "running",
        files,
        matchCount: session.matchCount,
        truncated: session.truncated,
        error: session.error,
      };
      if (done) destroy(session);
      return page;
    },

    cancel(searchId: string): void {
      const session = sessions.get(searchId);
      if (session !== undefined) destroy(session);
    },

    dispose(): void {
      for (const session of [...sessions.values()]) destroy(session);
    },

    liveSessionCount(): number {
      return sessions.size;
    },
  };
}
