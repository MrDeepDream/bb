import { describe, expect, it, vi } from "vitest";
import type {
  PluginComposerCustomizationSlot,
  PluginFileOpenerSlot,
  PluginMessageDirectiveSlot,
  PluginPendingInteractionSlot,
} from "./plugin-slots";
import {
  BUILT_IN_FILE_OPENER_PREFERENCE,
  buildFileOpenerRef,
  getFileOpenersForPath,
  resolveComposerActions,
  resolveComposerBanners,
  resolveComposerDraftObservers,
  resolveComposerEditorEffects,
  resolveComposerPlusMenuItems,
  resolveFileOpenerReplacement,
  resolveMessageDirectiveRegistry,
  resolvePendingInteraction,
  resolveReplacement,
} from "./plugin-slot-resolvers";

function Component() {
  return null;
}

function composerCustomization(
  overrides: Partial<PluginComposerCustomizationSlot> &
    Pick<PluginComposerCustomizationSlot, "id">,
): PluginComposerCustomizationSlot {
  return {
    pluginId: "composer-plugin",
    generation: 1,
    ...overrides,
  };
}

describe("Composer slot resolvers", () => {
  it("projects applicable contributions in registration order with generation keys", () => {
    const onDraftChange = vi.fn();
    const match = () => [];
    const all = composerCustomization({
      id: "all",
      actions: [{ id: "action", component: Component }],
      banners: [{ id: "banner", component: Component }],
      plusMenu: [{ id: "menu", label: "Menu", run: () => {} }],
      richText: {
        effects: [{ id: "effect", className: "effect", match }],
        onDraftChange,
      },
    });
    const thread = composerCustomization({
      id: "thread",
      scopes: ["thread"],
      actions: [{ id: "thread-action", component: Component }],
    });
    const newThread = composerCustomization({
      id: "new-thread",
      scopes: ["new-thread"],
      actions: [{ id: "hidden", component: Component }],
    });

    expect(resolveComposerActions([all, thread, newThread], "thread")).toEqual([
      expect.objectContaining({
        key: "composer-plugin/1/all/action",
        customizationId: "all",
      }),
      expect.objectContaining({
        key: "composer-plugin/1/thread/thread-action",
        customizationId: "thread",
      }),
    ]);
    expect(resolveComposerBanners([all], "thread")[0]?.banner.id).toBe(
      "banner",
    );
    expect(resolveComposerPlusMenuItems([all], "thread")[0]?.item.id).toBe(
      "menu",
    );
    expect(resolveComposerEditorEffects([all], "thread")[0]).toEqual(
      expect.objectContaining({ effects: all.richText?.effects }),
    );
    expect(resolveComposerDraftObservers([all], "thread")[0]).toEqual(
      expect.objectContaining({ onDraftChange }),
    );
  });

  it("treats omitted scopes as all, empty scopes as none, and changes keys by generation", () => {
    const all = composerCustomization({
      id: "all",
      actions: [{ id: "action", component: Component }],
    });
    const none = composerCustomization({
      id: "none",
      scopes: [],
      actions: [{ id: "hidden", component: Component }],
    });

    expect(resolveComposerActions([all, none], "queued-message")).toHaveLength(
      1,
    );
    expect(
      resolveComposerActions([{ ...all, generation: 2 }], "queued-message")[0]
        ?.key,
    ).toBe("composer-plugin/2/all/action");
  });
});

describe("keyed renderer resolvers", () => {
  it("resolves pending interactions by plugin and renderer id", () => {
    const mine: PluginPendingInteractionSlot = {
      pluginId: "mine",
      generation: 1,
      id: "form",
      component: Component,
    };
    const theirs = { ...mine, pluginId: "theirs" };

    expect(resolvePendingInteraction([theirs, mine], "mine", "form")).toBe(
      mine,
    );
    expect(resolvePendingInteraction([mine], "mine", "missing")).toBeNull();
  });

  it("resolves unique directives and reports deterministic collisions", () => {
    const alpha: PluginMessageDirectiveSlot = {
      pluginId: "zeta",
      generation: 1,
      id: "card",
      component: Component,
    };
    const beta = { ...alpha, pluginId: "alpha" };
    const chart = { ...alpha, id: "chart" };

    expect(
      resolveMessageDirectiveRegistry([alpha, beta, chart]).get("card"),
    ).toEqual({ status: "collision", pluginIds: ["alpha", "zeta"] });
  });
});

describe("replacement resolvers", () => {
  it("selects the first applicable provider and reveals the next after removal", () => {
    const alpha = { id: "alpha", applies: false };
    const beta = { id: "beta", applies: true };
    const gamma = { id: "gamma", applies: true };

    expect(
      resolveReplacement([alpha, beta, gamma], (candidate) =>
        Boolean(candidate.applies),
      ),
    ).toEqual({ kind: "plugin", registration: beta });
    expect(
      resolveReplacement([alpha, gamma], (candidate) =>
        Boolean(candidate.applies),
      ),
    ).toEqual({ kind: "plugin", registration: gamma });
    expect(resolveReplacement([], () => true)).toEqual({ kind: "owner" });
  });

  it("activates the first matching file opener and preserves per-open overrides", () => {
    const markdown: PluginFileOpenerSlot = {
      pluginId: "docs",
      generation: 1,
      id: "editor",
      title: "Editor",
      extensions: ["md"],
      component: Component,
    };
    const text = { ...markdown, id: "text", extensions: ["txt"] };
    const alternate = {
      ...markdown,
      pluginId: "alternate",
      id: "preview",
      title: "Preview",
    };

    expect(
      resolveFileOpenerReplacement({
        registrations: [markdown, text],
        path: "README.MD",
      }),
    ).toEqual({ kind: "plugin", registration: markdown });
    expect(
      resolveFileOpenerReplacement({
        registrations: [markdown, alternate],
        preference: { md: BUILT_IN_FILE_OPENER_PREFERENCE },
        path: "README.md",
      }),
    ).toEqual({ kind: "owner" });
    expect(
      resolveFileOpenerReplacement({
        registrations: [markdown, alternate],
        preference: { md: buildFileOpenerRef(alternate) },
        path: "README.md",
      }),
    ).toEqual({ kind: "plugin", registration: alternate });
    expect(
      resolveFileOpenerReplacement({
        registrations: [markdown, text],
        path: "README.md",
        override: { pluginId: "docs", openerId: "text" },
      }),
    ).toEqual({ kind: "plugin", registration: text });
    expect(
      resolveFileOpenerReplacement({
        registrations: [markdown],
        path: "README.md",
        override: "builtin",
      }),
    ).toEqual({ kind: "owner" });
    expect(
      resolveFileOpenerReplacement({
        registrations: [],
        path: "README.md",
      }),
    ).toEqual({ kind: "owner" });
  });

  it("reveals the next matching file opener when the first is removed", () => {
    const first: PluginFileOpenerSlot = {
      pluginId: "alpha",
      generation: 1,
      id: "markdown",
      title: "Alpha Markdown",
      extensions: ["md"],
      component: Component,
    };
    const second = { ...first, pluginId: "beta", title: "Beta Markdown" };

    expect(
      resolveFileOpenerReplacement({
        registrations: [first, second],
        path: "README.md",
      }),
    ).toEqual({ kind: "plugin", registration: first });
    expect(
      resolveFileOpenerReplacement({
        registrations: [second],
        path: "README.md",
      }),
    ).toEqual({ kind: "plugin", registration: second });
    expect(
      resolveFileOpenerReplacement({
        registrations: [second],
        preference: { md: buildFileOpenerRef(first) },
        path: "README.md",
      }),
    ).toEqual({ kind: "owner" });
  });
});

describe("file opener path routing", () => {
  const dotfiles: PluginFileOpenerSlot = {
    pluginId: "editor",
    generation: 1,
    id: "dotfiles",
    title: "Dotfiles",
    extensions: ["env", "gitignore"],
    component: Component,
  };
  const code: PluginFileOpenerSlot = {
    ...dotfiles,
    id: "code",
    title: "Code",
    extensions: ["json", "ts"],
  };
  const alternate: PluginFileOpenerSlot = {
    ...dotfiles,
    pluginId: "alternate",
    id: "env",
    title: "Alternate",
    extensions: ["env"],
  };
  const registrations = [dotfiles, code, alternate];
  const openerId = (
    path: string,
    preference?: Record<string, string>,
  ): string => {
    const resolved = resolveFileOpenerReplacement({
      registrations,
      path,
      ...(preference === undefined ? {} : { preference }),
    });
    return resolved.kind === "owner" ? "owner" : resolved.registration.id;
  };

  it.each([
    ["POSIX file", "/repo/src/index.ts", "code"],
    ["POSIX dotfile", "/repo/.env", "dotfiles"],
    ["POSIX gitignore", "/repo/.gitignore", "dotfiles"],
    ["POSIX multi-dot dotfile", "/repo/.env.local", "dotfiles"],
    ["POSIX uppercase dotfile", "/repo/.ENV", "dotfiles"],
    ["POSIX trailing separator", "/repo/.env/", "dotfiles"],
    ["POSIX dotted folder", "/repo.ts/Makefile", "owner"],
    ["Windows file", "C:\\repo\\src\\index.ts", "code"],
    ["Windows dotfile", "C:\\repo\\.env", "dotfiles"],
    ["Windows multi-dot dotfile", "C:\\repo\\.env.local", "dotfiles"],
    ["Windows forward slashes", "C:/repo/.env", "dotfiles"],
    ["Windows forward multi-dot", "C:/repo/.env.local", "dotfiles"],
    ["Windows dotted folder", "C:\\repo.ts\\Makefile", "owner"],
    ["UNC dotfile", "\\\\server\\share\\.gitignore", "dotfiles"],
    ["drive root", "C:\\", "owner"],
    ["relative dotfile", ".env", "dotfiles"],
    ["relative gitignore", ".gitignore", "dotfiles"],
    ["relative multi-dot dotfile", ".env.local", "dotfiles"],
    ["nested relative dotfile", "src/.env", "dotfiles"],
    ["dot-relative dotfile", "./.env.local", "dotfiles"],
    ["backslash relative dotfile", "src\\.env.local", "dotfiles"],
    ["relative dotted folder", "repo.ts/Makefile", "owner"],
    ["multi-dot file", "archive.test.ts", "code"],
    ["many-dot dotfile", ".env.production.local", "dotfiles"],
    ["claimed real extension", ".env.json", "code"],
    ["unclaimed dotfile", ".unknown", "owner"],
    ["unclaimed multi-dot dotfile", ".unknown.local", "owner"],
    ["trailing-dot file", "index.ts.", "owner"],
    ["trailing-dot dotfile", ".env.", "owner"],
    ["current directory", ".", "owner"],
    ["parent directory", "..", "owner"],
    ["no extension", "Makefile", "owner"],
  ])("routes a %s", (_label, path, expected) => {
    expect(openerId(path)).toBe(expected);
    const menuOpeners = getFileOpenersForPath(registrations, path);
    expect(menuOpeners[0]?.id ?? "owner").toBe(expected);
  });

  it("offers only the openers of the candidate that routes the file", () => {
    const ids = (path: string) =>
      getFileOpenersForPath(registrations, path).map((opener) => opener.id);

    expect(ids("C:\\repo\\.env.local")).toEqual(["dotfiles", "env"]);
    expect(ids(".env.json")).toEqual(["code"]);
    expect(ids("Makefile")).toEqual([]);
  });

  it.each([
    ["built-in for a dotfile", ".env", { env: "builtin" }, "owner"],
    ["built-in for the stem", ".env.local", { env: "builtin" }, "owner"],
    [
      "built-in for an unclaimed suffix",
      ".env.local",
      { local: "builtin" },
      "dotfiles",
    ],
    [
      "built-in for a real extension",
      ".env.json",
      { json: "builtin" },
      "owner",
    ],
    ["built-in for a losing stem", ".env.json", { env: "builtin" }, "code"],
    ["Windows built-in", "C:\\repo\\.env.local", { env: "builtin" }, "owner"],
    ["plugin for a dotfile", ".env", { env: "alternate" }, "env"],
    ["plugin for the stem", "src/.env.local", { env: "alternate" }, "env"],
  ])("honors a stored %s preference", (_label, path, stored, expected) => {
    const preference = Object.fromEntries(
      Object.entries(stored).map(([key, value]) => [
        key,
        value === "builtin"
          ? BUILT_IN_FILE_OPENER_PREFERENCE
          : buildFileOpenerRef(alternate),
      ]),
    );
    expect(openerId(path, preference)).toBe(expected);
  });
});
