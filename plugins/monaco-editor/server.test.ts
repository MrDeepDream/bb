import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const source = {
  kind: "thread-storage",
  threadId: "thread-editor-test",
  environmentId: "environment-editor-test",
  projectId: null,
};
const storageRootPath = "/remote-storage/thread-editor-test";
const hostId = "remote-editor-host";

async function setup(root = storageRootPath) {
  const storageLocation = vi.fn(() => ({ hostId, storageRootPath: root }));
  const read = vi.fn(() => ({
    content: "saved text",
    contentEncoding: "utf8",
    sizeBytes: 10,
    sha256: "original",
  }));
  const listPaths = vi.fn(() => ({
    paths: [{ path: "notes/document.txt", kind: "file" }],
    truncated: false,
  }));
  const write = vi.fn(() => ({ outcome: "written", sha256: "updated" }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "monaco-editor",
    sdk: {
      system: { config: () => ({ dataDir: "/server-data" }) },
      threads: { storageLocation },
      files: { read, listPaths, write },
    },
  });
  await plugin(bb);
  return { harness, storageLocation, read, listPaths, write };
}

describe("thread storage host routing", () => {
  it("reads from the thread's storage host and root", async () => {
    const { harness, read, storageLocation } = await setup();
    const result = await harness.callRpc("read", {
      source,
      path: "notes/document.txt",
    });
    expect(read).toHaveBeenCalledWith({
      hostId,
      rootPath: storageRootPath,
      path: `${storageRootPath}/notes/document.txt`,
    });
    expect(storageLocation).toHaveBeenCalledWith({ threadId: source.threadId });
    expect(result).toMatchObject({
      kind: "text",
      content: "saved text",
      absolutePath: `${storageRootPath}/notes/document.txt`,
      relativePath: "notes/document.txt",
    });
  });

  it.each([
    [
      "//server/share/storage",
      "\\\\server\\share\\storage\\notes\\document.txt",
    ],
    ["C:", "C:\\notes\\document.txt"],
  ])("reads and names files under %s", async (root, expected) => {
    const { harness, read } = await setup(root);
    try {
      expect(
        await harness.callRpc("read", { source, path: "notes/document.txt" }),
      ).toMatchObject({
        absolutePath: expected,
        relativePath: "notes/document.txt",
      });
      expect(read).toHaveBeenCalledWith({
        hostId,
        rootPath: root,
        path: expected,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("lists the thread's storage host and root", async () => {
    const { harness, listPaths } = await setup();
    const result = await harness.callRpc("tree", {
      source,
      path: "notes/document.txt",
    });
    expect(listPaths).toHaveBeenCalledWith({
      hostId,
      path: storageRootPath,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: true,
      limit: 10_000,
    });
    expect(result).toEqual({
      root: storageRootPath,
      hostId,
      environmentId: null,
      entries: [{ path: "notes/document.txt", kind: "file" }],
      truncated: false,
    });
  });

  it("saves to the thread's storage host with the expected version", async () => {
    const { harness, write } = await setup();
    const result = await harness.callRpc("write", {
      source,
      path: "notes/document.txt",
      content: "edited text",
      expectedSha256: "original",
    });
    expect(write).toHaveBeenCalledWith({
      hostId,
      rootPath: storageRootPath,
      path: `${storageRootPath}/notes/document.txt`,
      content: "edited text",
      contentEncoding: "utf8",
      expectedSha256: "original",
    });
    expect(result).toEqual({ outcome: "written", sha256: "updated" });
  });
});

describe("write boundary", () => {
  const environmentRoot = "/work/env";
  const projectRoot = "/work/project";

  async function boundarySetup(fileOverrides: Record<string, unknown> = {}) {
    const read = vi.fn(() => ({
      content: "saved text",
      contentEncoding: "utf8",
      sizeBytes: 10,
      sha256: "original",
      modifiedAtMs: 5,
      ...fileOverrides,
    }));
    const write = vi.fn(() => ({ outcome: "written", sha256: "updated" }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "monaco-editor",
      sdk: {
        system: { config: () => ({ dataDir: "/server-data" }) },
        environments: {
          get: () => ({ id: "env_1", hostId, path: environmentRoot }),
        },
        projects: {
          list: async () => [
            {
              id: "project_1",
              sources: [{ hostId, path: projectRoot, isDefault: true }],
            },
          ],
        },
        files: { read, write },
      },
    });
    await plugin(bb);
    return { harness, read, write };
  }

  const hostSource = {
    kind: "host",
    threadId: null,
    environmentId: "env_1",
    projectId: null,
  };

  it.each([
    [
      "inside the environment",
      `${environmentRoot}/a.ts`,
      false,
      environmentRoot,
    ],
    ["inside a project source", `${projectRoot}/a.ts`, false, projectRoot],
    ["outside every root", "/etc/hosts", true, "/etc"],
  ])("reads a host file %s", async (_name, filePath, readOnly, readRoot) => {
    const { harness, read } = await boundarySetup();
    const result = await harness.callRpc("read", {
      source: hostSource,
      path: filePath,
    });
    expect(result).toMatchObject({
      kind: "text",
      readOnly,
      hostId,
      documentKey: `${hostId}::${filePath}`,
      fingerprint: "5:10",
    });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: readRoot, path: filePath }),
    );
  });

  it("rejects a write outside every root and never calls the host", async () => {
    const { harness, write } = await boundarySetup();
    await expect(
      harness.callRpc("write", {
        source: hostSource,
        path: "/etc/hosts",
        content: "edited",
        expectedSha256: "original",
      }),
    ).rejects.toThrow(/read-only/);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes a project file under the project root", async () => {
    const { harness, write } = await boundarySetup();
    await harness.callRpc("write", {
      source: hostSource,
      path: `${projectRoot}/a.ts`,
      content: "edited",
      expectedSha256: "original",
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: projectRoot,
        path: `${projectRoot}/a.ts`,
      }),
    );
  });

  it("rejects text over 8 MiB before resolving the target", async () => {
    const { harness, write } = await boundarySetup();
    await expect(
      harness.callRpc("write", {
        source: hostSource,
        path: `${environmentRoot}/a.ts`,
        content: "é".repeat(4 * 1024 * 1024 + 1),
        expectedSha256: "original",
      }),
    ).rejects.toThrow(/too large/);
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects a write with no expected version field", async () => {
    const { harness, write } = await boundarySetup();
    await expect(
      harness.callRpc("write", {
        source: hostSource,
        path: `${environmentRoot}/a.ts`,
        content: "edited",
      }),
    ).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["NUL bytes", { content: "text\0more" }],
    ["base64 content", { contentEncoding: "base64" }],
    ["more than 8 MiB", { sizeBytes: 8 * 1024 * 1024 + 1 }],
  ])("hands a file with %s to the preview", async (_name, overrides) => {
    const { harness } = await boundarySetup(overrides);
    await expect(
      harness.callRpc("read", {
        source: hostSource,
        path: `${environmentRoot}/a.bin`,
      }),
    ).resolves.toMatchObject({ kind: "unsupported" });
  });

  it("hands a file the host refuses as too large to the preview", async () => {
    const { harness, read } = await boundarySetup();
    read.mockImplementationOnce(() => {
      throw Object.assign(new Error("too large"), { status: 413 });
    });
    await expect(
      harness.callRpc("read", {
        source: hostSource,
        path: `${environmentRoot}/huge.log`,
      }),
    ).resolves.toMatchObject({ kind: "unsupported" });
  });
});

describe("find in files boundary", () => {
  const environmentRoot = "/workspace/env";
  const projectRoot = "/projects/app";
  const search = { query: "needle", mode: "literal", caseSensitive: false };

  async function searchSetup() {
    const callHost = vi.fn((call: { method: string }) =>
      call.method === "searchStart"
        ? { searchId: "11111111-1111-4111-8111-111111111111" }
        : null,
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "monaco-editor",
      experimental_callHostRpc: callHost,
      sdk: {
        system: { config: () => ({ dataDir: "/server-data" }) },
        environments: {
          get: () => ({ id: "env_1", hostId, path: environmentRoot }),
        },
        projects: {
          list: async () => [
            {
              id: "project_1",
              sources: [{ hostId, path: projectRoot, isDefault: true }],
            },
          ],
        },
        threads: {
          storageLocation: () => ({ hostId, storageRootPath }),
        },
      },
    });
    await plugin(bb);
    return { harness, callHost };
  }

  const hostFile = (path: string) => ({
    path,
    source: {
      kind: "host",
      threadId: null,
      environmentId: "env_1",
      projectId: null,
    },
  });

  it.each([
    ["an environment file", `${environmentRoot}/src/a.ts`, environmentRoot],
    ["a project file", `${projectRoot}/src/a.ts`, projectRoot],
  ])("derives the root for %s", async (_name, path, rootPath) => {
    const { harness, callHost } = await searchSetup();
    const result = await harness.callRpc("searchStart", {
      ...search,
      file: hostFile(path),
    });
    expect(result).toMatchObject({ kind: "started", root: rootPath, hostId });
    expect(callHost).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "searchStart",
        hostId,
        input: { ...search, limit: 2_000, rootPath },
      }),
    );
  });

  it("searches an environment root from the CLI target path", async () => {
    const { harness, callHost } = await searchSetup();
    await harness.callRpc("searchStart", {
      ...search,
      file: {
        path: ".",
        source: {
          kind: "workspace",
          threadId: null,
          environmentId: "env_1",
          projectId: null,
        },
      },
    });
    expect(callHost).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ rootPath: environmentRoot }),
      }),
    );
  });

  it.each([
    ["a host file outside every root", hostFile("/etc/hosts")],
    ["a thread-storage file", { path: "notes.md", source }],
  ])("has no search root for %s", async (_name, file) => {
    const { harness, callHost } = await searchSetup();
    expect(
      await harness.callRpc("searchStart", { ...search, file }),
    ).toMatchObject({ kind: "unavailable" });
    expect(callHost).not.toHaveBeenCalled();
  });

  it("rejects a raw root path from the caller", async () => {
    const { harness, callHost } = await searchSetup();
    await expect(
      harness.callRpc("searchStart", {
        ...search,
        rootPath: "/",
        file: hostFile(`${projectRoot}/a.ts`),
      }),
    ).rejects.toThrow();
    expect(callHost).not.toHaveBeenCalled();
  });

  it("routes pull and cancel to the host that owns the search", async () => {
    const { harness, callHost } = await searchSetup();
    const started = (await harness.callRpc("searchStart", {
      ...search,
      file: hostFile(`${projectRoot}/a.ts`),
    })) as { searchId: string };
    await harness.callRpc("searchCancel", { searchId: started.searchId });
    expect(callHost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "searchCancel",
        hostId,
        input: { searchId: "11111111-1111-4111-8111-111111111111" },
      }),
    );
  });
});

describe("gitMarkers", () => {
  const environmentRoot = "/work/env";
  const projectRoot = "/work/project";

  type PatchInput = {
    target: Record<string, string>;
    paths: string[];
  };

  const gitPatch = (path: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

  async function markerSetup(
    respond: (input: PatchInput, rootPath: string) => unknown = (
      { paths },
      rootPath,
    ) => ({
      outcome: "available",
      rootPath,
      patches: paths.map((path) => ({
        path,
        patch: gitPatch(path),
        truncated: false,
      })),
      deferred: [],
    }),
    initialRoot = environmentRoot,
    isRepositoryRoot: () => boolean = () => true,
  ) {
    let workspaceRoot = initialRoot;
    const inputs: PatchInput[] = [];
    const callRpc = vi.fn(async (args: { input?: unknown }) => {
      const input = args.input as PatchInput;
      inputs.push(input);
      return respond(
        input,
        "environmentId" in input.target ? workspaceRoot : projectRoot,
      );
    });
    const callHost = vi.fn(async (call: { method: string; input: unknown }) =>
      call.method === "isRepositoryRoot" ? isRepositoryRoot() : null,
    );
    const rootChecks = () =>
      callHost.mock.calls
        .map(([call]) => call)
        .filter((call) => call.method === "isRepositoryRoot")
        .map((call) => call.input);
    const { bb, harness } = createFakePluginHost({
      pluginId: "monaco-editor",
      experimental_callHostRpc: callHost,
      sdk: {
        subscribe: () => () => undefined,
        system: { config: () => ({ dataDir: "/server-data" }) },
        environments: {
          get: () => ({ id: "env_1", hostId, path: workspaceRoot }),
        },
        plugins: { callRpc },
        projects: {
          list: async () => [
            {
              id: "project_1",
              sources: [{ hostId, path: projectRoot, isDefault: true }],
            },
          ],
        },
      },
    });
    await plugin(bb);
    return {
      harness,
      callRpc,
      inputs,
      rootChecks,
      moveWorkspace: (rootPath: string) => {
        workspaceRoot = rootPath;
      },
    };
  }

  const hostFile = (path: string) => ({
    path,
    source: {
      kind: "host",
      threadId: null,
      environmentId: "env_1",
      projectId: null,
    },
  });
  const keyOf = (path: string) => `${hostId}::${path}`;

  it("makes one Git call per target for many documents", async () => {
    const { harness, callRpc, inputs } = await markerSetup();
    const environmentFiles = ["a.ts", "b.ts", "src/c.ts"];
    const projectFiles = ["d.ts", "e.ts"];
    const result = (await harness.callRpc("gitMarkers", {
      documents: [
        ...environmentFiles.map((name) =>
          hostFile(`${environmentRoot}/${name}`),
        ),
        ...projectFiles.map((name) => hostFile(`${projectRoot}/${name}`)),
      ],
    })) as { states: Record<string, unknown> };

    expect(callRpc).toHaveBeenCalledTimes(2);
    expect(inputs).toEqual(
      expect.arrayContaining([
        {
          target: { environmentId: "env_1" },
          paths: environmentFiles,
        },
        {
          target: { projectId: "project_1", hostId },
          paths: projectFiles,
        },
      ]),
    );
    expect(callRpc.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "bb--git",
      method: "patchesByPath",
    });
    expect(result.states[keyOf(`${environmentRoot}/src/c.ts`)]).toEqual({
      kind: "patch",
      patch: gitPatch("src/c.ts"),
    });
    expect(result.states[keyOf(`${projectRoot}/e.ts`)]).toEqual({
      kind: "patch",
      patch: gitPatch("e.ts"),
    });
  });

  it("splits a target into batches of 50 paths", async () => {
    const { harness, inputs } = await markerSetup();
    await harness.callRpc("gitMarkers", {
      documents: Array.from({ length: 51 }, (_, index) =>
        hostFile(`${environmentRoot}/f${index}.ts`),
      ),
    });
    expect(inputs.map(({ paths }) => paths.length)).toEqual([50, 1]);
  });

  it("uses the containing project for a host tab from another environment", async () => {
    const { harness, inputs } = await markerSetup();
    await harness.callRpc("gitMarkers", {
      documents: [hostFile(`${projectRoot}/a.ts`)],
    });
    expect(inputs[0]?.target).toEqual({ projectId: "project_1", hostId });
  });

  it("sends Windows paths to Git with forward slashes", async () => {
    const { harness, inputs } = await markerSetup(undefined, "E:\\repo");
    await harness.callRpc("gitMarkers", {
      documents: [hostFile("E:\\repo\\src\\nested\\a.ts")],
    });
    expect(inputs[0]?.paths).toEqual(["src/nested/a.ts"]);
  });

  it("marks a file outside every root unavailable without a Git call", async () => {
    const { harness, callRpc } = await markerSetup();
    const result = await harness.callRpc("gitMarkers", {
      documents: [hostFile("/etc/hosts")],
    });
    expect(result).toEqual({
      states: { [keyOf("/etc/hosts")]: { kind: "unavailable" } },
    });
    expect(callRpc).not.toHaveBeenCalled();
  });

  it("maps each path to its own state", async () => {
    const { harness } = await markerSetup((_input, rootPath) => ({
      outcome: "available",
      rootPath,
      patches: [
        { path: "changed.ts", patch: gitPatch("changed.ts"), truncated: false },
        { path: "clean.ts", patch: "", truncated: false },
        { path: "huge.ts", patch: gitPatch("huge.ts"), truncated: true },
      ],
      deferred: ["later.ts"],
    }));
    const names = ["changed.ts", "clean.ts", "huge.ts", "later.ts", "lost.ts"];
    const result = (await harness.callRpc("gitMarkers", {
      documents: names.map((name) => hostFile(`${environmentRoot}/${name}`)),
    })) as { states: Record<string, unknown> };
    expect(
      names.map((name) => result.states[keyOf(`${environmentRoot}/${name}`)]),
    ).toEqual([
      { kind: "patch", patch: gitPatch("changed.ts") },
      { kind: "clean" },
      { kind: "unavailable" },
      { kind: "deferred" },
      { kind: "unavailable" },
    ]);
  });

  it("checks a root once across repeated reads", async () => {
    const { harness, rootChecks } = await markerSetup();
    const documents = ["a.ts", "b.ts"].map((name) =>
      hostFile(`${environmentRoot}/${name}`),
    );
    await harness.callRpc("gitMarkers", { documents });
    await harness.callRpc("gitMarkers", { documents });
    expect(rootChecks()).toEqual([{ rootPath: environmentRoot }]);
  });

  it("checks again when the target's root changes", async () => {
    const { harness, rootChecks, moveWorkspace } = await markerSetup();
    await harness.callRpc("gitMarkers", {
      documents: [hostFile(`${environmentRoot}/a.ts`)],
    });
    moveWorkspace("/work/moved");
    await harness.callRpc("gitMarkers", {
      documents: [hostFile("/work/moved/a.ts")],
    });
    expect(rootChecks()).toEqual([
      { rootPath: environmentRoot },
      { rootPath: "/work/moved" },
    ]);
  });

  it("reads no patches for a root inside a repository subdirectory", async () => {
    const { harness, callRpc } = await markerSetup(
      undefined,
      environmentRoot,
      () => false,
    );
    await expect(
      harness.callRpc("gitMarkers", {
        documents: [hostFile(`${environmentRoot}/a.ts`)],
      }),
    ).resolves.toEqual({
      states: { [keyOf(`${environmentRoot}/a.ts`)]: { kind: "unavailable" } },
    });
    expect(callRpc).not.toHaveBeenCalled();
  });

  it("stays unavailable after a failed root check and retries it", async () => {
    let failing = true;
    const { harness, callRpc } = await markerSetup(
      undefined,
      environmentRoot,
      () => {
        if (failing) throw new Error("host offline");
        return true;
      },
    );
    const documents = [hostFile(`${environmentRoot}/a.ts`)];
    await expect(harness.callRpc("gitMarkers", { documents })).resolves.toEqual(
      {
        states: { [keyOf(`${environmentRoot}/a.ts`)]: { kind: "unavailable" } },
      },
    );
    expect(callRpc).not.toHaveBeenCalled();
    failing = false;
    await expect(harness.callRpc("gitMarkers", { documents })).resolves.toEqual(
      {
        states: {
          [keyOf(`${environmentRoot}/a.ts`)]: {
            kind: "patch",
            patch: gitPatch("a.ts"),
          },
        },
      },
    );
  });

  it.each([
    [
      "a patch whose header names another file",
      (rootPath: string) => ({
        outcome: "available",
        rootPath,
        patches: [{ path: "a.ts", patch: gitPatch("b.ts"), truncated: false }],
        deferred: [],
      }),
    ],
    [
      "a patch under a key it did not request",
      (rootPath: string) => ({
        outcome: "available",
        rootPath,
        patches: [{ path: "b.ts", patch: gitPatch("b.ts"), truncated: false }],
        deferred: [],
      }),
    ],
    [
      "a result read from another root",
      () => ({
        outcome: "available",
        rootPath: "/work/other",
        patches: [{ path: "a.ts", patch: gitPatch("a.ts"), truncated: false }],
        deferred: [],
      }),
    ],
  ])("refuses %s", async (_name, respond) => {
    const { harness } = await markerSetup((_input, rootPath) =>
      respond(rootPath),
    );
    await expect(
      harness.callRpc("gitMarkers", {
        documents: [hostFile(`${environmentRoot}/a.ts`)],
      }),
    ).resolves.toEqual({
      states: { [keyOf(`${environmentRoot}/a.ts`)]: { kind: "unavailable" } },
    });
  });

  it.each([
    [
      "a missing Git plugin",
      () => {
        throw new Error("Plugin not found");
      },
    ],
    [
      "a non-repository",
      () => ({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Not git",
      }),
    ],
    [
      "an unborn HEAD",
      () => ({
        outcome: "unavailable",
        failure: {
          code: "unknown",
          workspacePath: environmentRoot,
          message: "This repository has no commits yet.",
        },
      }),
    ],
  ])("returns unavailable with no error for %s", async (_name, respond) => {
    const { harness } = await markerSetup(respond);
    await expect(
      harness.callRpc("gitMarkers", {
        documents: [hostFile(`${environmentRoot}/a.ts`)],
      }),
    ).resolves.toEqual({
      states: {
        [keyOf(`${environmentRoot}/a.ts`)]: { kind: "unavailable" },
      },
    });
  });
});
