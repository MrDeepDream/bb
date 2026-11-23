import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  experimental_joinHostPath as joinHostPath,
  experimental_getHostPathComparisonKey as getHostPathComparisonKey,
  experimental_getHostPathDirname as getHostPathDirname,
  experimental_getHostPathBasename as getHostPathBasename,
  experimental_getRelativeHostPath as getRelativeHostPath,
  experimental_isHostPathWithin as isHostPathWithin,
  experimental_normalizeHostPath as normalizeHostPath,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { documentKeyFor } from "./lib/document-key.js";
import { monacoHostContract, monacoHostSignals } from "./lib/host-contract.js";
import {
  fileSchema,
  GIT_MARKERS_CHANNEL,
  rpcContract,
  searchRequestSchema,
  sourceSchema,
  type GitMarkerState,
} from "./lib/rpc-contract.js";
import { patchNamesPath } from "./lib/git-hunks.js";
import { createSearchCli } from "./lib/search-cli.js";

const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;

const MAX_TREE_ENTRIES = 10_000;

const ASSET_LEASE_TTL_MS = 60 * 60 * 1000;

const ASSET_LEASE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const PROJECT_ROOTS_TTL_MS = 30_000;

const HOST_CALL_TIMEOUT_MS = 10_000;

const SEARCH_PULL_TIMEOUT_MS = 20_000;

const GIT_PLUGIN_ID = "bb--git";

const GIT_PATCH_BATCH_PATHS = 50;

const REPOSITORY_ROOT_TTL_MS = 30_000;

const MAX_REPOSITORY_ROOT_CHECKS = 256;

function isSameHostRoot(left: string, right: string): boolean {
  const key = getHostPathComparisonKey(left);
  return key !== null && key === getHostPathComparisonKey(right);
}

const gitPatchesOutputSchema = z.union([
  z.object({
    outcome: z.literal("available"),
    rootPath: z.string(),
    patches: z.array(
      z.object({
        path: z.string(),
        patch: z.string(),
        truncated: z.boolean(),
      }),
    ),
    deferred: z.array(z.string()),
  }),
  z.object({ outcome: z.enum(["not_applicable", "unavailable"]) }),
]);

type FileSource = z.infer<typeof sourceSchema>;

type GitTarget =
  | { kind: "environment"; environmentId: string }
  | { kind: "project"; projectId: string; hostId: string };

type ResolvedTarget = {
  path: string;
  hostId?: string;
  readRoot: string;
  writeRoot: string | null;
  gitTarget: GitTarget | null;
  documentKey: string;
};

type ProjectRoot = { projectId: string; path: string };

type RetainedRoot = {
  hostId: string;
  rootPath: string;
  tag: string;
  holders: number;
};

function rootTag(hostId: string, rootPath: string): string {
  return `root:${hostId}:${getHostPathComparisonKey(rootPath) ?? rootPath}`;
}

function containingProjectRoot(
  roots: readonly ProjectRoot[],
  filePath: string,
): ProjectRoot | null {
  let best: ProjectRoot | null = null;
  for (const root of roots) {
    if (
      isHostPathWithin({ rootPath: root.path, candidatePath: filePath }) &&
      (best === null || root.path.length > best.path.length)
    ) {
      best = root;
    }
  }
  return best;
}

function isFileTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 413
  );
}

function workspacePath(rootPath: string, relativePath: string): string {
  const path = joinHostPath({ rootPath, relativePath });
  if (path === null) throw new Error("Workspace path must be absolute");
  if (!isHostPathWithin({ rootPath, candidatePath: path })) {
    throw new Error("File must stay inside its root");
  }
  return path;
}

function parseSearchId(searchId: string): {
  hostSearchId: string;
  hostId: string;
} {
  const separator = searchId.indexOf(":");
  return {
    hostSearchId: searchId.slice(0, separator),
    hostId: searchId.slice(separator + 1),
  };
}

function isBundleStale(moduleDir: string, bundleDir: string): boolean {
  const builtAtMs = statSync(path.join(bundleDir, "editor.js")).mtimeMs;
  const entryDir = path.join(moduleDir, "monaco-bundle");
  if (!existsSync(entryDir)) return false;

  const inputs = [
    path.join(moduleDir, "scripts", "stage-assets.mjs"),
    ...readdirSync(entryDir).map((name) => path.join(entryDir, name)),
    path.join(moduleDir, "package.json"),
  ];
  return inputs.some(
    (input) => existsSync(input) && statSync(input).mtimeMs > builtAtMs,
  );
}

async function ensureMonacoBundleDir(
  log: (message: string) => void,
): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "monaco"),
    path.join(moduleDir, "dist", "monaco"),
  ];
  const built = candidates.find((candidate) =>
    existsSync(path.join(candidate, "editor.js")),
  );
  if (built !== undefined && !isBundleStale(moduleDir, built)) return built;

  log(
    built === undefined
      ? "Monaco bundle missing; building it (first run in a source checkout)"
      : "Monaco bundle is older than its sources; rebuilding it",
  );
  const script = new URL("./scripts/stage-assets.mjs", import.meta.url).href;
  await import(script);

  const staged = candidates.find((candidate) =>
    existsSync(path.join(candidate, "editor.js")),
  );
  if (staged === undefined) {
    throw new Error(
      "could not build the Monaco bundle; run `pnpm --filter bb-plugin-monaco-editor build:monaco`",
    );
  }
  return staged;
}

export default async function plugin(bb: BbPluginApi) {
  let assetLease: { baseUrl: string; expiresAtMs: number } | null = null;

  async function assets() {
    const now = Date.now();
    if (
      assetLease === null ||
      assetLease.expiresAtMs - now < ASSET_LEASE_REFRESH_MARGIN_MS
    ) {
      const bundleDir = await ensureMonacoBundleDir((message) =>
        bb.log.info(message),
      );
      assetLease = await bb.sdk.files.createPreview({
        rootPath: bundleDir,
        ttlMs: ASSET_LEASE_TTL_MS,
      });
    }
    return assetLease;
  }

  let projectRootsCache: {
    expiresAtMs: number;
    roots: Promise<ReadonlyMap<string, readonly ProjectRoot[]>>;
  } | null = null;

  function projectRootsByHost(
    fresh: boolean,
  ): Promise<ReadonlyMap<string, readonly ProjectRoot[]>> {
    const now = Date.now();
    if (
      !fresh &&
      projectRootsCache !== null &&
      projectRootsCache.expiresAtMs > now
    ) {
      return projectRootsCache.roots;
    }
    const roots = bb.sdk.projects.list().then((projects) => {
      const byHost = new Map<string, ProjectRoot[]>();
      for (const project of projects) {
        for (const source of project.sources) {
          const list = byHost.get(source.hostId) ?? [];
          list.push({ projectId: project.id, path: source.path });
          byHost.set(source.hostId, list);
        }
      }
      return byHost;
    });
    const entry = { expiresAtMs: now + PROJECT_ROOTS_TTL_MS, roots };
    projectRootsCache = entry;
    roots.catch(() => {
      if (projectRootsCache === entry) projectRootsCache = null;
    });
    return roots;
  }

  function createLookups() {
    const environments = new Map<
      string,
      ReturnType<typeof bb.sdk.environments.get>
    >();
    const storage = new Map<
      string,
      ReturnType<typeof bb.sdk.threads.storageLocation>
    >();
    return {
      environment(environmentId: string) {
        const cached = environments.get(environmentId);
        if (cached !== undefined) return cached;
        const loaded = bb.sdk.environments.get({ environmentId });
        environments.set(environmentId, loaded);
        return loaded;
      },
      storage(threadId: string) {
        const cached = storage.get(threadId);
        if (cached !== undefined) return cached;
        const loaded = bb.sdk.threads.storageLocation({ threadId });
        storage.set(threadId, loaded);
        return loaded;
      },
    };
  }

  function rootedTarget(args: {
    hostId: string | undefined;
    rootPath: string;
    filePath: string;
    gitTarget: GitTarget | null;
  }): ResolvedTarget {
    const resolved = workspacePath(args.rootPath, args.filePath);
    return {
      path: resolved,
      ...(args.hostId !== undefined ? { hostId: args.hostId } : {}),
      readRoot: args.rootPath,
      writeRoot: args.rootPath,
      gitTarget: args.gitTarget,
      documentKey: documentKeyFor(args.hostId, resolved),
    };
  }

  async function resolveHostTarget(
    source: FileSource,
    filePath: string,
    lookups: ReturnType<typeof createLookups>,
    freshRoots: boolean,
  ): Promise<ResolvedTarget> {
    const normalized = normalizeHostPath(filePath);
    if (normalized === null) {
      throw new Error("Host file paths must be absolute");
    }
    const environment =
      source.environmentId === null
        ? null
        : await lookups.environment(source.environmentId);
    if (environment === null && source.experimental_hostId === undefined) {
      throw new Error("This file has no host to resolve it against");
    }
    const hostId =
      source.experimental_hostId ?? environment?.hostId ?? undefined;
    const hostFields = hostId !== undefined ? { hostId } : {};
    const documentKey = documentKeyFor(hostId, normalized);
    if (
      environment !== null &&
      source.environmentId !== null &&
      environment.path &&
      (source.experimental_hostId === undefined ||
        source.experimental_hostId === environment.hostId) &&
      isHostPathWithin({
        rootPath: environment.path,
        candidatePath: normalized,
      })
    ) {
      return {
        path: normalized,
        ...hostFields,
        readRoot: environment.path,
        writeRoot: environment.path,
        gitTarget: {
          kind: "environment",
          environmentId: source.environmentId,
        },
        documentKey,
      };
    }
    if (hostId !== undefined) {
      const roots = await projectRootsByHost(freshRoots);
      const project = containingProjectRoot(
        roots.get(hostId) ?? [],
        normalized,
      );
      if (project !== null) {
        return {
          path: normalized,
          hostId,
          readRoot: project.path,
          writeRoot: project.path,
          gitTarget: { kind: "project", projectId: project.projectId, hostId },
          documentKey,
        };
      }
    }
    const parent = getHostPathDirname(normalized);
    if (parent === null) throw new Error("Host file paths must be absolute");
    return {
      path: normalized,
      ...hostFields,
      readRoot: parent,
      writeRoot: null,
      gitTarget: null,
      documentKey,
    };
  }

  async function resolveTarget(
    source: FileSource,
    filePath: string,
    {
      lookups = createLookups(),
      freshRoots = false,
    }: {
      lookups?: ReturnType<typeof createLookups>;
      freshRoots?: boolean;
    } = {},
  ): Promise<ResolvedTarget> {
    if (source.kind === "host") {
      return resolveHostTarget(source, filePath, lookups, freshRoots);
    }
    if (source.kind === "thread-storage") {
      if (source.threadId === null) {
        throw new Error("This thread-storage file has no thread");
      }
      const { hostId, storageRootPath } = await lookups.storage(
        source.threadId,
      );
      return rootedTarget({
        hostId,
        rootPath: storageRootPath,
        filePath,
        gitTarget: null,
      });
    }
    if (source.environmentId === null) {
      if (source.projectId === null) {
        throw new Error("This file has no environment or project");
      }
      const project = await bb.sdk.projects.get({
        projectId: source.projectId,
      });
      const sources = project.sources;
      const checkout =
        source.experimental_hostId === undefined
          ? (sources.find((entry) => entry.isDefault) ?? sources[0])
          : sources.find(
              (entry) => entry.hostId === source.experimental_hostId,
            );
      if (checkout === undefined) {
        throw new Error("This project has no matching source checkout");
      }
      return rootedTarget({
        hostId: checkout.hostId,
        rootPath: checkout.path,
        filePath,
        gitTarget: {
          kind: "project",
          projectId: source.projectId,
          hostId: checkout.hostId,
        },
      });
    }
    const environment = await lookups.environment(source.environmentId);
    if (!environment.path) {
      throw new Error("This environment has no workspace path");
    }
    return rootedTarget({
      hostId: environment.hostId ?? undefined,
      rootPath: environment.path,
      filePath,
      gitTarget: { kind: "environment", environmentId: source.environmentId },
    });
  }

  const hostClient = bb.hosts.experimental_client({
    contract: monacoHostContract,
    experimental_signals: monacoHostSignals,
  });
  const retainedRoots = new Map<string, RetainedRoot>();
  const repositoryRootChecks = new Map<
    string,
    { hostId: string; expiresAtMs: number; result: Promise<boolean> }
  >();

  function checkRepositoryRoot(
    hostId: string,
    rootPath: string,
    gitTarget: GitTarget,
  ): Promise<boolean> {
    const key = JSON.stringify([
      hostId,
      getHostPathComparisonKey(rootPath) ?? rootPath,
      gitTarget,
    ]);
    const now = Date.now();
    const known = repositoryRootChecks.get(key);
    if (known !== undefined && known.expiresAtMs > now) return known.result;
    repositoryRootChecks.delete(key);
    if (repositoryRootChecks.size >= MAX_REPOSITORY_ROOT_CHECKS) {
      const [oldest] = repositoryRootChecks.keys();
      if (oldest !== undefined) repositoryRootChecks.delete(oldest);
    }
    const result = hostClient.call(
      "isRepositoryRoot",
      { rootPath },
      { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
    );
    const entry = { hostId, expiresAtMs: now + REPOSITORY_ROOT_TTL_MS, result };
    repositoryRootChecks.set(key, entry);
    result.catch(() => {
      if (repositoryRootChecks.get(key) === entry) {
        repositoryRootChecks.delete(key);
      }
    });
    return result;
  }

  function startRootWatch(root: RetainedRoot) {
    hostClient
      .call(
        "watchRoot",
        { rootPath: root.rootPath },
        { hostId: root.hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
      )
      .catch((error: unknown) => {
        bb.log.warn(
          `Could not watch ${root.rootPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  function retainRoot(hostId: string, rootPath: string, signal: AbortSignal) {
    if (signal.aborted) return;
    const tag = rootTag(hostId, rootPath);
    let root = retainedRoots.get(tag);
    if (root === undefined) {
      root = { hostId, rootPath, tag, holders: 0 };
      retainedRoots.set(tag, root);
      startRootWatch(root);
    }
    root.holders += 1;
    const held = root;
    signal.addEventListener(
      "abort",
      () => {
        held.holders -= 1;
        if (held.holders > 0 || retainedRoots.get(tag) !== held) return;
        retainedRoots.delete(tag);
        void hostClient
          .call(
            "unwatchRoot",
            { rootPath: held.rootPath },
            { hostId: held.hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
          )
          .catch(() => undefined);
      },
      { once: true },
    );
  }

  hostClient.experimental_onSignal("rootChanged", ({ hostId, payload }) => {
    bb.rpc.experimental_invalidate([rootTag(hostId, payload.rootPath)]);
  });
  hostClient.experimental_onWorkerExit(({ hostId }) => {
    for (const [key, check] of repositoryRootChecks) {
      if (check.hostId === hostId) repositoryRootChecks.delete(key);
    }
    const tags: string[] = [];
    for (const root of retainedRoots.values()) {
      if (root.hostId !== hostId) continue;
      startRootWatch(root);
      tags.push(root.tag);
    }
    if (tags.length > 0) bb.rpc.experimental_invalidate(tags);
  });

  async function resolveDocuments(
    documents: readonly z.infer<typeof fileSchema>[],
  ): Promise<ResolvedTarget[]> {
    const lookups = createLookups();
    const targets = await Promise.all(
      documents.map((document) =>
        resolveTarget(document.source, document.path, { lookups }).catch(
          () => null,
        ),
      ),
    );
    return targets.filter((target) => target !== null);
  }

  function relativeTo(root: string, target: string): string {
    const relative = getRelativeHostPath({
      rootPath: root,
      candidatePath: target,
    });
    const name = relative === "" ? getHostPathBasename(target) : relative;
    if (name === null) throw new Error("File must stay inside its root");
    return name;
  }

  let stopGitRefEvents: (() => void) | null = null;

  function publishGitRefChanges(): void {
    stopGitRefEvents ??= bb.sdk.subscribe({
      event: "environment:changed",
      callback: ({ changes }) => {
        if (changes.includes("git-refs-changed")) {
          bb.realtime.publish(GIT_MARKERS_CHANNEL, null);
        }
      },
    });
  }

  bb.onDispose(() => {
    stopGitRefEvents?.();
    stopGitRefEvents = null;
  });

  async function readGitPatchBatch(
    gitTarget: GitTarget,
    rootPath: string,
    paths: string[],
    signal: AbortSignal,
  ): Promise<Map<string, GitMarkerState>> {
    const states = new Map<string, GitMarkerState>(
      paths.map((path) => [path, { kind: "unavailable" }]),
    );
    const result = await bb.sdk.plugins
      .callRpc({
        pluginId: GIT_PLUGIN_ID,
        method: "patchesByPath",
        input: {
          target:
            gitTarget.kind === "environment"
              ? { environmentId: gitTarget.environmentId }
              : { projectId: gitTarget.projectId, hostId: gitTarget.hostId },
          paths,
        },
        outputSchema: gitPatchesOutputSchema,
        signal,
      })
      .catch(() => null);
    if (
      result === null ||
      result.outcome !== "available" ||
      !isSameHostRoot(result.rootPath, rootPath)
    ) {
      return states;
    }
    for (const { path, patch, truncated } of result.patches) {
      if (truncated || !states.has(path)) continue;
      if (patch.length === 0) states.set(path, { kind: "clean" });
      else if (patchNamesPath(patch, path)) {
        states.set(path, { kind: "patch", patch });
      }
    }
    for (const path of result.deferred) {
      if (states.has(path)) states.set(path, { kind: "deferred" });
    }
    return states;
  }

  async function readGitMarkers(
    documents: readonly z.infer<typeof fileSchema>[],
    signal: AbortSignal,
  ): Promise<Record<string, GitMarkerState>> {
    const targets = await resolveDocuments(documents);
    const states: Record<string, GitMarkerState> = {};
    const groups = new Map<
      string,
      {
        gitTarget: GitTarget;
        hostId: string;
        rootPath: string;
        keyByPath: Map<string, string>;
      }
    >();
    for (const target of targets) {
      if (target.gitTarget === null || target.hostId === undefined) {
        states[target.documentKey] = { kind: "unavailable" };
        continue;
      }
      const groupKey = JSON.stringify([
        target.gitTarget,
        target.hostId,
        target.readRoot,
      ]);
      const group = groups.get(groupKey) ?? {
        gitTarget: target.gitTarget,
        hostId: target.hostId,
        rootPath: target.readRoot,
        keyByPath: new Map<string, string>(),
      };
      group.keyByPath.set(
        relativeTo(target.readRoot, target.path),
        target.documentKey,
      );
      groups.set(groupKey, group);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const { gitTarget, hostId, rootPath, keyByPath } = group;
        const atRepositoryRoot = await checkRepositoryRoot(
          hostId,
          rootPath,
          gitTarget,
        ).catch(() => false);
        if (!atRepositoryRoot) {
          for (const documentKey of keyByPath.values()) {
            states[documentKey] = { kind: "unavailable" };
          }
          return;
        }
        const paths = [...keyByPath.keys()];
        for (
          let start = 0;
          start < paths.length;
          start += GIT_PATCH_BATCH_PATHS
        ) {
          const batch = await readGitPatchBatch(
            gitTarget,
            rootPath,
            paths.slice(start, start + GIT_PATCH_BATCH_PATHS),
            signal,
          );
          for (const [path, state] of batch) {
            const documentKey = keyByPath.get(path);
            if (documentKey !== undefined) states[documentKey] = state;
          }
        }
      }),
    );
    return states;
  }

  async function startSearch({
    file,
    ...options
  }: z.output<typeof searchRequestSchema>) {
    const target = await resolveTarget(file.source, file.path);
    if (target.gitTarget === null || target.hostId === undefined) {
      return {
        kind: "unavailable" as const,
        reason:
          "This file is outside a project or workspace, so there is no folder to search.",
      };
    }
    const { searchId } = await hostClient.call(
      "searchStart",
      { ...options, rootPath: target.readRoot },
      { hostId: target.hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
    );
    return {
      kind: "started" as const,
      searchId: `${searchId}:${target.hostId}`,
      root: target.readRoot,
      hostId: target.hostId,
      environmentId:
        target.gitTarget.kind === "environment"
          ? target.gitTarget.environmentId
          : null,
    };
  }

  function nextSearchPage(searchId: string, signal?: AbortSignal) {
    const { hostId, hostSearchId } = parseSearchId(searchId);
    return hostClient.call(
      "searchNext",
      { searchId: hostSearchId },
      {
        hostId,
        timeoutMs: SEARCH_PULL_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async function cancelSearch(searchId: string): Promise<void> {
    const { hostId, hostSearchId } = parseSearchId(searchId);
    await hostClient.call(
      "searchCancel",
      { searchId: hostSearchId },
      { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
    );
  }

  bb.cli.register(
    createSearchCli({
      start: startSearch,
      next: nextSearchPage,
      cancel: cancelSearch,
      threadEnvironment: async (threadId) =>
        (await bb.sdk.threads.get({ threadId })).environmentId,
    }),
  );

  bb.rpc.register(rpcContract, {
    assets: () => assets(),

    async gitMarkers({ documents }, context) {
      publishGitRefChanges();
      return {
        states: await readGitMarkers(documents, context.experimental_signal),
      };
    },

    searchStart: (input) => startSearch(input),

    searchNext: ({ searchId }, context) =>
      nextSearchPage(searchId, context.experimental_signal),

    async searchCancel({ searchId }) {
      await cancelSearch(searchId);
      return null;
    },

    async read({ path: filePath, source }) {
      const target = await resolveTarget(source, filePath);
      let file: Awaited<ReturnType<typeof bb.sdk.files.read>>;
      try {
        file = await bb.sdk.files.read({
          path: target.path,
          rootPath: target.readRoot,
          ...(target.hostId !== undefined ? { hostId: target.hostId } : {}),
        });
      } catch (error) {
        if (!isFileTooLargeError(error)) throw error;
        return {
          kind: "unsupported" as const,
          reason: "This file is too large to edit",
        };
      }

      if (file.contentEncoding !== "utf8" || file.content.includes("\0")) {
        return {
          kind: "unsupported" as const,
          reason: "This file is not text",
        };
      }
      if (file.sizeBytes > MAX_EDITABLE_BYTES) {
        return {
          kind: "unsupported" as const,
          reason: `This file is too large to edit (${Math.round(file.sizeBytes / 1024 / 1024)} MB)`,
        };
      }
      return {
        kind: "text" as const,
        content: file.content,
        sha256: file.sha256,
        absolutePath: target.path,
        relativePath: relativeTo(target.readRoot, target.path),
        documentKey: target.documentKey,
        hostId: target.hostId ?? null,
        readOnly: target.writeRoot === null,
        fingerprint:
          file.modifiedAtMs === undefined
            ? null
            : `${file.modifiedAtMs}:${file.sizeBytes}`,
      };
    },

    async tree({ path: filePath, source }) {
      const target = await resolveTarget(source, filePath);
      const result = await bb.sdk.files.listPaths({
        path: target.readRoot,
        includeFiles: true,
        includeDirectories: true,
        includeHidden: true,
        limit: MAX_TREE_ENTRIES,
        ...(target.hostId !== undefined ? { hostId: target.hostId } : {}),
      });
      return {
        root: target.readRoot,
        hostId: target.hostId ?? null,
        environmentId:
          target.gitTarget?.kind === "environment"
            ? target.gitTarget.environmentId
            : null,
        entries: result.paths.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
        })),
        truncated: result.truncated,
      };
    },

    async write({ path: filePath, source, content, expectedSha256 }) {
      if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_BYTES) {
        throw new Error("This file is too large to save");
      }
      const target = await resolveTarget(source, filePath, {
        freshRoots: true,
      });
      if (target.writeRoot === null) {
        throw new Error("This file is outside the project and is read-only");
      }
      const result = await bb.sdk.files.write({
        path: target.path,
        rootPath: target.writeRoot,
        ...(target.hostId !== undefined ? { hostId: target.hostId } : {}),
        content,
        contentEncoding: "utf8",
        expectedSha256,
      });
      if (result.outcome === "written")
        bb.internal_DO_NOT_USE_recordPluginUse();
      return result.outcome === "written"
        ? { outcome: "written" as const, sha256: result.sha256 }
        : { outcome: "conflict" as const, currentSha256: result.currentSha256 };
    },

    async documentFingerprints({ documents }) {
      const targets = await resolveDocuments(documents);
      const pathsByHost = new Map<string, Set<string>>();
      const rootTags = new Set<string>();
      for (const target of targets) {
        if (target.hostId === undefined) continue;
        const paths = pathsByHost.get(target.hostId) ?? new Set<string>();
        paths.add(target.path);
        pathsByHost.set(target.hostId, paths);
        if (target.writeRoot !== null) {
          rootTags.add(rootTag(target.hostId, target.writeRoot));
        }
      }
      const valuesByHost = new Map(
        await Promise.all(
          [...pathsByHost].map(async ([hostId, paths]) => {
            const values = await hostClient
              .call(
                "fingerprints",
                { paths: [...paths] },
                { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
              )
              .catch(() => null);
            return [hostId, values] as const;
          }),
        ),
      );
      const fingerprints: Record<string, string | null> = {};
      for (const target of targets) {
        if (target.hostId === undefined) continue;
        const value = valuesByHost.get(target.hostId)?.[target.path];
        if (value !== undefined) fingerprints[target.documentKey] = value;
      }
      return { fingerprints, rootTags: [...rootTags] };
    },
  });

  bb.rpc.experimental_whileWatched("documentFingerprints", (read, signal) => {
    if (!("input" in read)) return;
    const input = rpcContract.documentFingerprints.input.safeParse(read.input);
    if (!input.success) return;
    void resolveDocuments(input.data.documents).then((targets) => {
      for (const target of targets) {
        if (target.hostId !== undefined && target.writeRoot !== null) {
          retainRoot(target.hostId, target.writeRoot, signal);
        }
      }
    });
  });
}
