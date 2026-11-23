import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_getHostPathComparisonKey as comparisonKey } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { parseGitHunks } from "./git-hunks.js";
import { isRepositoryRoot } from "./host-search.js";
import type { GitMarkerState } from "./rpc-contract.js";

const hostId = "real-git-host";
const TEST_TIMEOUT_MS = 30_000;
const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5 }),
      ),
  );
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "--no-pager",
      "-c",
      "user.name=Marker Test",
      "-c",
      "user.email=markers@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "diff.noprefix=false",
      "-c",
      "diff.mnemonicPrefix=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
}

async function tempDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "bb-monaco-markers-")),
  );
  created.push(directory);
  return directory;
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

async function committedRepository(
  files: Record<string, string>,
): Promise<string> {
  const root = await tempDirectory();
  git(root, "init", "-q");
  await writeFiles(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

function hostPatches(rootPath: string, paths: string[]) {
  const [onlyPath] = paths;
  if (paths.length === 1 && onlyPath !== undefined) {
    const patch = git(rootPath, "diff", "HEAD", "--", onlyPath);
    return [{ path: onlyPath, patch, truncated: false }];
  }
  const requested = new Set(paths);
  return git(rootPath, "diff", "HEAD", "--name-only", "-z", "--", ...paths)
    .split("\0")
    .filter((name) => requested.has(name))
    .map((name) => ({
      path: name,
      patch: git(rootPath, "diff", "HEAD", "--", `:(top,literal)${name}`),
      truncated: false,
    }));
}

async function readMarkers(rootPath: string, relativePaths: string[]) {
  const gitReads: string[][] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "monaco-editor",
    experimental_callHostRpc: (call: { method: string; input: unknown }) =>
      call.method === "isRepositoryRoot"
        ? isRepositoryRoot(
            (call.input as { rootPath: string }).rootPath,
            new AbortController().signal,
          )
        : null,
    sdk: {
      subscribe: () => () => undefined,
      system: { config: () => ({ dataDir: "/server-data" }) },
      environments: { get: () => ({ id: "env_1", hostId, path: rootPath }) },
      plugins: {
        callRpc: async (args: { input?: unknown }) => {
          const { paths } = args.input as { paths: string[] };
          gitReads.push(paths);
          return {
            outcome: "available",
            rootPath,
            patches: await hostPatches(rootPath, paths),
            deferred: [],
          };
        },
      },
      projects: { list: async () => [] },
    },
  });
  await plugin(bb);
  const { states } = (await harness.callRpc("gitMarkers", {
    documents: relativePaths.map((relativePath) => ({
      path: path.join(rootPath, relativePath),
      source: {
        kind: "host",
        threadId: null,
        environmentId: "env_1",
        projectId: null,
      },
    })),
  })) as { states: Record<string, GitMarkerState> };
  return {
    gitReads,
    stateOf: (relativePath: string) =>
      states[`${hostId}::${comparisonKey(path.join(rootPath, relativePath))}`],
  };
}

describe("Git markers against a real repository", () => {
  it(
    "gives nested same-named files no markers from a subdirectory root",
    async () => {
      const repository = await committedRepository({
        "sub/a.ts": "outer\n",
        "sub/sub/a.ts": "inner\n",
      });
      await writeFiles(repository, {
        "sub/a.ts": "outer changed\n",
        "sub/sub/a.ts": "inner changed\n",
      });
      const root = path.join(repository, "sub");

      const unguarded = await hostPatches(root, ["a.ts", "sub/a.ts"]);
      expect(
        unguarded.find((entry) => entry.path === "sub/a.ts")?.patch,
      ).toContain("outer changed");

      const { gitReads, stateOf } = await readMarkers(root, [
        "a.ts",
        "sub/a.ts",
      ]);
      expect(stateOf("a.ts")).toEqual({ kind: "unavailable" });
      expect(stateOf("sub/a.ts")).toEqual({ kind: "unavailable" });
      expect(gitReads).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives each nested file its own marker from the repository top level",
    async () => {
      const repository = await committedRepository({
        "sub/a.ts": "outer\n",
        "sub/sub/a.ts": "inner\n",
      });
      await writeFiles(repository, {
        "sub/a.ts": "outer changed\n",
        "sub/sub/a.ts": "inner changed\n",
      });

      const { gitReads, stateOf } = await readMarkers(repository, [
        "sub/a.ts",
        "sub/sub/a.ts",
      ]);
      expect(gitReads).toHaveLength(1);
      for (const [file, own, other] of [
        ["sub/a.ts", "outer changed", "inner changed"],
        ["sub/sub/a.ts", "inner changed", "outer changed"],
      ] as const) {
        const state = stateOf(file);
        if (state?.kind !== "patch") throw new Error(`${file} has no patch`);
        expect(state.patch).toContain(own);
        expect(state.patch).not.toContain(other);
        expect(parseGitHunks(state.patch, 1)).toEqual([
          { kind: "modified", startLine: 1, endLine: 1 },
        ]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a patch that a glob-like path matched from another file",
    async () => {
      const repository = await committedRepository({
        "app/[id]/x.ts": "bracket\n",
        "app/i/x.ts": "plain\n",
      });
      await writeFiles(repository, { "app/i/x.ts": "plain changed\n" });

      const unguarded = await hostPatches(repository, ["app/[id]/x.ts"]);
      expect(unguarded[0]?.patch).toContain("plain changed");

      const { stateOf } = await readMarkers(repository, ["app/[id]/x.ts"]);
      expect(stateOf("app/[id]/x.ts")).toEqual({ kind: "unavailable" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "recognises only a repository's top level as its root",
    async () => {
      const repository = await committedRepository({ "sub/a.ts": "text\n" });
      const outside = await tempDirectory();
      const { signal } = new AbortController();
      await expect(isRepositoryRoot(repository, signal)).resolves.toBe(true);
      await expect(
        isRepositoryRoot(path.join(repository, "sub"), signal),
      ).resolves.toBe(false);
      await expect(isRepositoryRoot(outside, signal)).resolves.toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
