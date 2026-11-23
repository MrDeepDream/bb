import { describe, expect, it, vi } from "vitest";
import {
  createDesktopUnloadGuard,
  type DesktopUnloadPrompt,
  type DesktopUnloadWindow,
} from "../src/desktop-unload-guard";
import { connectServersAdoptTarget } from "../src/server-target";

function createWindow(id: number) {
  const close = vi.fn<() => void>();
  return {
    webContents: { id },
    isDestroyed: () => false,
    close,
  } satisfies DesktopUnloadWindow;
}

function setup(answer: boolean) {
  const prompt = vi.fn(
    async (_request: DesktopUnloadPrompt<DesktopUnloadWindow>) => answer,
  );
  return {
    guard: createDesktopUnloadGuard({ prompt, logError: vi.fn() }),
    prompt,
  };
}

function closeEvent() {
  return { preventDefault: vi.fn() };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("window close", () => {
  it("passes a clean window without a prompt", () => {
    const { guard, prompt } = setup(false);
    const event = closeEvent();
    expect(guard.blockWindowClose(event, createWindow(1))).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps a dirty window open when the user keeps editing", async () => {
    const { guard, prompt } = setup(false);
    const window = createWindow(1);
    guard.setDirty(1, true);
    const event = closeEvent();
    expect(guard.blockWindowClose(event, window)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await settle();
    expect(prompt).toHaveBeenCalledOnce();
    expect(window.close).not.toHaveBeenCalled();
    expect(guard.blockWindowClose(closeEvent(), window)).toBe(true);
  });

  it("closes once after approval and lets that close through", async () => {
    const { guard } = setup(true);
    const window = createWindow(1);
    guard.setDirty(1, true);
    expect(guard.blockWindowClose(closeEvent(), window)).toBe(true);
    await settle();
    expect(window.close).toHaveBeenCalledOnce();
    const retry = closeEvent();
    expect(guard.blockWindowClose(retry, window)).toBe(false);
    expect(retry.preventDefault).not.toHaveBeenCalled();
  });

  it("asks once while repeated closes arrive", async () => {
    const { guard, prompt } = setup(false);
    const window = createWindow(1);
    guard.setDirty(1, true);
    guard.blockWindowClose(closeEvent(), window);
    guard.blockWindowClose(closeEvent(), window);
    await settle();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("never closes a dirty window on the renderer-timeout retry", async () => {
    vi.useFakeTimers();
    try {
      const prompt = vi.fn(() => new Promise<boolean>(() => undefined));
      const guard = createDesktopUnloadGuard<DesktopUnloadWindow>({
        prompt,
        logError: vi.fn(),
      });
      const window = createWindow(1);
      guard.setDirty(1, true);
      setTimeout(() => {
        const event = closeEvent();
        if (!guard.blockWindowClose(event, window)) window.close();
      }, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(window.close).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a failed dialog as keep editing", async () => {
    const prompt = vi.fn(async () => {
      throw new Error("dialog failed");
    });
    const guard = createDesktopUnloadGuard<DesktopUnloadWindow>({
      prompt,
      logError: vi.fn(),
    });
    const window = createWindow(1);
    guard.setDirty(1, true);
    guard.blockWindowClose(closeEvent(), window);
    await settle();
    expect(window.close).not.toHaveBeenCalled();
  });
});

describe("quit", () => {
  it.each([
    { answer: false, resumes: 0 },
    { answer: true, resumes: 1 },
  ])("resumes $resumes times when the answer is $answer", async (row) => {
    const { guard } = setup(row.answer);
    const resume = vi.fn();
    guard.setDirty(1, true);
    const event = closeEvent();
    expect(guard.blockQuit(event, resume)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    await settle();
    expect(resume).toHaveBeenCalledTimes(row.resumes);
  });

  it("does not block a clean quit", () => {
    const { guard, prompt } = setup(false);
    guard.setDirty(1, false);
    expect(guard.blockQuit(closeEvent(), vi.fn())).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("lets every window close after an approved quit", async () => {
    const { guard } = setup(true);
    guard.setDirty(1, true);
    guard.setDirty(2, true);
    guard.blockQuit(closeEvent(), vi.fn());
    await settle();
    expect(guard.blockWindowClose(closeEvent(), createWindow(1))).toBe(false);
    expect(guard.blockWindowClose(closeEvent(), createWindow(2))).toBe(false);
  });

  it("skips the prompt after a signal shutdown approves everything", () => {
    const { guard, prompt } = setup(false);
    guard.setDirty(1, true);
    guard.approveAll();
    expect(guard.blockQuit(closeEvent(), vi.fn())).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe.each(["reload"] as const)("%s", (route) => {
  it("runs teardown only after approval", async () => {
    const teardown = vi.fn();
    const { guard } = setup(false);
    const window = createWindow(1);
    guard.setDirty(1, true);
    if (await guard.confirmWindowUnload(route, window)) teardown();
    expect(teardown).not.toHaveBeenCalled();
    expect(guard.hasDirtyWindow(1)).toBe(true);
  });

  it("stays dirty after approval until the page really navigates", async () => {
    const { guard } = setup(true);
    guard.setDirty(1, true);
    await expect(
      guard.confirmWindowUnload(route, createWindow(1)),
    ).resolves.toBe(true);
    expect(guard.hasDirtyWindow(1)).toBe(true);
    guard.setDirty(1, false);
    expect(guard.hasDirtyWindow(1)).toBe(false);
  });
});

describe.each(["server", "update"] as const)("%s", (route) => {
  it("does not prompt when nothing is dirty", async () => {
    const { guard, prompt } = setup(false);
    await expect(guard.confirmAppUnload(route, null)).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("runs teardown only after approval", async () => {
    const teardown = vi.fn();
    const { guard, prompt } = setup(false);
    guard.setDirty(1, true);
    if (await guard.confirmAppUnload(route, null)) teardown();
    expect(teardown).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith({ route, window: null });
    expect(guard.hasDirtyWindow(1)).toBe(true);
  });

  it("keeps protecting the window when teardown fails after approval", async () => {
    const { guard } = setup(true);
    const window = createWindow(1);
    guard.setDirty(1, true);
    await expect(guard.confirmAppUnload(route, null)).resolves.toBe(true);
    guard.clearApproval();
    expect(guard.blockWindowClose(closeEvent(), window)).toBe(true);
  });
});

it("restores protection after a failed update clears approval", () => {
  const { guard } = setup(false);
  const window = createWindow(1);
  guard.setDirty(1, true);
  guard.approveAll();
  expect(guard.blockWindowClose(closeEvent(), window)).toBe(false);
  guard.clearApproval();
  expect(guard.blockWindowClose(closeEvent(), window)).toBe(true);
});

describe("server target routes", () => {
  function createRoute() {
    const events: string[] = [];
    return {
      events,
      async switchTarget() {
        events.push("target");
      },
      async load() {
        events.push("load");
      },
    };
  }

  describe.each([
    "server menu",
    "built-in server",
    "server URL dialog",
    "startup action",
    "Connect sign-in",
    "watched server move",
  ])("%s", () => {
    it("leaves target and window alone on Keep editing", async () => {
      const { guard, prompt } = setup(false);
      const route = createRoute();
      guard.setDirty(1, true);
      await expect(
        guard.runApprovedUnload("server", null, async () => {
          await route.switchTarget();
          await guard.navigate(route.load);
        }),
      ).resolves.toBe(false);
      expect(prompt).toHaveBeenCalledWith({ route: "server", window: null });
      expect(route.events).toEqual([]);
    });

    it("changes the target only after approval, then navigates", async () => {
      const { guard } = setup(true);
      const route = createRoute();
      guard.setDirty(1, true);
      await expect(
        guard.runApprovedUnload("server", null, async () => {
          await route.switchTarget();
          await guard.navigate(route.load);
        }),
      ).resolves.toBe(true);
      expect(route.events).toEqual(["target", "load"]);
    });
  });

  it("asks once when an approved route calls another approved route", async () => {
    const { guard, prompt } = setup(true);
    const route = createRoute();
    guard.setDirty(1, true);
    await guard.runApprovedUnload("server", null, () =>
      guard
        .runApprovedUnload("server", null, () => guard.navigate(route.load))
        .then(() => undefined),
    );
    expect(prompt).toHaveBeenCalledOnce();
    expect(route.events).toEqual(["load"]);
  });

  it("does not leave approval open after the route ends", async () => {
    const { guard } = setup(true);
    const route = createRoute();
    guard.setDirty(1, true);
    await guard.runApprovedUnload("server", null, async () => undefined);
    await guard.navigate(route.load);
    expect(route.events).toEqual([]);
  });

  it.each(["runtime exit error", "installer wait view", "session renewal"])(
    "holds a %s load until the window is clean",
    async () => {
      const { guard, prompt } = setup(false);
      const route = createRoute();
      guard.setDirty(1, true);
      await guard.navigate(route.load);
      expect(route.events).toEqual([]);
      expect(prompt).not.toHaveBeenCalled();
      guard.setDirty(1, false);
      await settle();
      expect(route.events).toEqual(["load"]);
    },
  );

  it("keeps only the newest held load", async () => {
    const { guard } = setup(false);
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    guard.setDirty(1, true);
    await guard.navigate(first);
    await guard.navigate(second);
    guard.forget(1);
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("drops a held load once an approved route navigates", async () => {
    const { guard } = setup(true);
    const held = vi.fn(async () => undefined);
    const route = createRoute();
    guard.setDirty(1, true);
    await guard.navigate(held);
    await guard.runApprovedUnload("server", null, () =>
      guard.navigate(route.load),
    );
    guard.setDirty(1, false);
    await settle();
    expect(held).not.toHaveBeenCalled();
    expect(route.events).toEqual(["load"]);
  });

  it("retries a declined background route once the window is clean", async () => {
    const { guard } = setup(false);
    const retry = vi.fn();
    guard.setDirty(1, true);
    guard.runWhenClean("server-move", retry);
    await settle();
    expect(retry).not.toHaveBeenCalled();
    guard.setDirty(1, false);
    await settle();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not run held work during a quit", async () => {
    const { guard } = setup(true);
    const held = vi.fn(async () => undefined);
    guard.setDirty(1, true);
    await guard.navigate(held);
    guard.approveAll();
    guard.forget(1);
    await settle();
    expect(held).not.toHaveBeenCalled();
  });

  it("passes a startup route with no renderer without a prompt", async () => {
    const { guard, prompt } = setup(false);
    const route = createRoute();
    await guard.runApprovedUnload("server", null, async () => {
      await route.switchTarget();
      await guard.navigate(route.load);
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(route.events).toEqual(["target", "load"]);
  });

  it.each([
    { url: "https://a.test/", kind: "custom", adopts: true },
    { url: "https://b.test/", kind: "custom", adopts: false },
    { url: "https://a.test/", kind: "builtin", adopts: false },
  ] as const)(
    "reports adoption of $url from a $kind target as $adopts",
    ({ url, kind, adopts }) => {
      const target =
        kind === "custom"
          ? ({ kind, url: "https://a.test" } as const)
          : ({ kind } as const);
      expect(
        connectServersAdoptTarget(target, [{ handle: "h", name: "n", url }]),
      ).toBe(adopts);
    },
  );
});
