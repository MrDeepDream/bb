import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchOptions, SearchPage } from "./host-contract";
import { createSearchSessions, grepArgs } from "./host-search";

const processes = vi.hoisted(() => ({
  hangGrep: false,
  spawned: [] as ChildProcess[],
}));

vi.mock("@get-bb/plugin-sdk/host", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/host")>();
  return {
    ...actual,
    experimental_spawnPortableOutputProcess: (
      request: Parameters<
        typeof actual.experimental_spawnPortableOutputProcess
      >[0],
    ) => {
      const hung = processes.hangGrep && request.args.includes("grep");
      const child = actual.experimental_spawnPortableOutputProcess(
        hung
          ? {
              ...request,
              command: process.execPath,
              args: ["-e", "setInterval(() => {}, 1000)"],
            }
          : request,
      );
      if (hung) processes.spawned.push(child);
      return child;
    },
  };
});

const created: string[] = [];
const activeSessions: ReturnType<typeof createSearchSessions>[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bb-monaco-search-"));
  created.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function repository(): Promise<string> {
  const root = await tempDir();
  git(root, "init", "-q");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\nbuild/\n");
  await writeFile(path.join(root, "tracked.txt"), "tracked needle\n");
  git(root, "add", "tracked.txt", ".gitignore");
  await writeFile(path.join(root, "untracked.txt"), "untracked needle\n");
  await writeFile(path.join(root, "ignored.txt"), "ignored needle\n");
  await mkdir(path.join(root, "build"));
  await writeFile(path.join(root, "build", "out.txt"), "built needle\n");
  return root;
}

function sessions() {
  const value = createSearchSessions();
  activeSessions.push(value);
  return value;
}

function options(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    query: "needle",
    mode: "literal",
    caseSensitive: true,
    limit: 100,
    ...overrides,
  };
}

async function collect(
  search: ReturnType<typeof createSearchSessions>,
  searchId: string,
) {
  const paths: string[] = [];
  const signal = new AbortController().signal;
  let page: SearchPage;
  do {
    page = await search.next(searchId, signal);
    for (const file of page.files) {
      for (const _match of file.matches) paths.push(file.path);
    }
  } while (page.status === "running");
  return { page, paths: paths.sort() };
}

async function runSearch(rootPath: string, overrides?: Partial<SearchOptions>) {
  const search = sessions();
  const { searchId } = search.start({ ...options(overrides), rootPath });
  return collect(search, searchId);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const search of activeSessions.splice(0)) search.dispose();
  processes.hangGrep = false;
  processes.spawned.length = 0;
  await Promise.all(
    created.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    ),
  );
});

describe("host search on a real git repo", { timeout: 30_000 }, () => {
  it("returns tracked and untracked files and honors .gitignore", async () => {
    const { page, paths } = await runSearch(await repository());
    expect(paths).toEqual(["tracked.txt", "untracked.txt"]);
    expect(page).toMatchObject({
      status: "done",
      matchCount: 2,
      truncated: null,
      error: null,
    });
  });

  it("searches a non-repository directory and honors .gitignore", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, ".gitignore"), "skip.txt\n");
    await writeFile(path.join(root, "keep.txt"), "needle\n");
    await writeFile(path.join(root, "skip.txt"), "needle\n");
    const { page, paths } = await runSearch(root);
    expect(paths).toEqual(["keep.txt"]);
    expect(page.error).toBeNull();
  });

  it.each(["-v", "--no-index", "--open-files-in-pager=calc"])(
    "treats the query %s as text",
    async (query) => {
      const root = await repository();
      await writeFile(path.join(root, "flags.txt"), `before ${query} after\n`);
      const { page, paths } = await runSearch(root, { query });
      expect(paths).toEqual(["flags.txt"]);
      expect(page.error).toBeNull();
    },
  );

  it("passes shell metacharacters to git unchanged", async () => {
    const root = await repository();
    const query = `a"b&c|d^e%PATH%`;
    await writeFile(path.join(root, "meta.txt"), `x ${query} y\n`);
    const { paths } = await runSearch(root, { query });
    expect(paths).toEqual(["meta.txt"]);
  });

  it("always places the query after -e and ends options with --", () => {
    const args = grepArgs(options({ query: "--help" }), true);
    expect(args[args.indexOf("-e") + 1]).toBe("--help");
    expect(args.at(-1)).toBe("--");
    expect(args).not.toContain("-P");
  });

  it("stops at the limit and reports it", async () => {
    const root = await repository();
    await writeFile(path.join(root, "many.txt"), "needle\n".repeat(200_000));
    const { page, paths } = await runSearch(root, { limit: 5 });
    expect(paths).toHaveLength(5);
    expect(page).toMatchObject({ matchCount: 5, truncated: "limit" });
  });

  it("does not report truncation when the limit is met exactly", async () => {
    const { page, paths } = await runSearch(await repository(), { limit: 2 });
    expect(paths).toHaveLength(2);
    expect(page.truncated).toBeNull();
  });

  it("cancels a running search and expires its session", async () => {
    const root = await repository();
    await writeFile(path.join(root, "big.txt"), "needle\n".repeat(400_000));
    const search = sessions();
    const { searchId } = search.start({
      ...options({ limit: 20_000 }),
      rootPath: root,
    });
    search.cancel(searchId);
    expect(search.liveSessionCount()).toBe(0);
    const page = await search.next(searchId, new AbortController().signal);
    expect(page.status).toBe("expired");
  });

  it("kills a running process on cancel", async () => {
    processes.hangGrep = true;
    const search = sessions();
    const { searchId } = search.start({
      ...options(),
      rootPath: await repository(),
    });
    await vi.waitFor(() => expect(processes.spawned).toHaveLength(1), {
      timeout: 10_000,
    });
    const child = processes.spawned[0];
    if (child === undefined) throw new Error("grep did not spawn");
    const closed = new Promise((resolve) => child.once("close", resolve));
    search.cancel(searchId);
    await closed;
    expect(child.exitCode).not.toBe(0);
  });

  it("kills a process at the wall-clock cap and reports it", async () => {
    processes.hangGrep = true;
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) =>
      realSetTimeout(
        callback,
        delay === 60_000 ? 300 : delay,
      )) as typeof setTimeout);
    const { page, paths } = await runSearch(await repository());
    expect(paths).toEqual([]);
    expect(page).toMatchObject({
      status: "done",
      truncated: "time",
      error: null,
    });
  });

  it("shows an invalid regex as git's error, not as no matches", async () => {
    const { page } = await runSearch(await repository(), {
      query: "[",
      mode: "regex",
    });
    expect(page.status).toBe("done");
    expect(page.error).toContain("Invalid regular expression");
  });

  it("reports no matches for exit 1", async () => {
    const { page, paths } = await runSearch(await repository(), {
      query: "absent-text-xyz",
    });
    expect(paths).toEqual([]);
    expect(page).toMatchObject({ status: "done", error: null });
  });

  it("reports a spawn failure, not no matches", async () => {
    const missing = path.join(await tempDir(), "does-not-exist");
    const { page } = await runSearch(missing);
    expect(page.status).toBe("done");
    expect(page.error).toMatch(/Could not run git/u);
  });

  it("does not run a hostile core.fsmonitor from the repository", async () => {
    const root = await repository();
    const marker = path.join(root, "fsmonitor-ran");
    const hook = path.join(root, "hook.sh");
    await writeFile(
      hook,
      `#!/bin/sh\ntouch "${marker.replaceAll("\\", "/")}"\nexit 1\n`,
      { mode: 0o755 },
    );
    git(root, "config", "core.fsmonitor", hook.replaceAll("\\", "/"));
    execFileSync("git", ["status", "--short"], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const hookRuns = existsSync(marker);
    await rm(marker, { force: true });
    const { paths } = await runSearch(root);
    expect(hookRuns).toBe(true);
    expect(paths).toContain("tracked.txt");
    expect(existsSync(marker)).toBe(false);
  });

  it("expires a session 30 seconds after the last pull", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await repository();
    const search = sessions();
    const { searchId } = search.start({ ...options(), rootPath: root });
    expect(search.liveSessionCount()).toBe(1);
    vi.advanceTimersByTime(30_001);
    expect(search.liveSessionCount()).toBe(0);
    const page = await search.next(searchId, new AbortController().signal);
    expect(page.status).toBe("expired");
  });

  it("bounds live sessions by evicting the oldest", async () => {
    const root = await repository();
    const search = sessions();
    const first = search.start({ ...options(), rootPath: root });
    search.start({ ...options(), rootPath: root });
    search.start({ ...options(), rootPath: root });
    search.start({ ...options(), rootPath: root });
    expect(search.liveSessionCount()).toBe(3);
    const page = await search.next(
      first.searchId,
      new AbortController().signal,
    );
    expect(page.status).toBe("expired");
  });

  it("returns pages no larger than 1 MiB", async () => {
    const root = await repository();
    const line = `needle ${"x".repeat(400)}\n`;
    await writeFile(path.join(root, "wide.txt"), line.repeat(6_000));
    const search = sessions();
    const { searchId } = search.start({
      ...options({ limit: 6_000 }),
      rootPath: root,
    });
    const signal = new AbortController().signal;
    let total = 0;
    let page: SearchPage;
    do {
      page = await search.next(searchId, signal);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        1024 * 1024,
      );
      total += page.files.reduce((sum, file) => sum + file.matches.length, 0);
    } while (page.status === "running");
    expect(total).toBe(6_000);
  });
});
