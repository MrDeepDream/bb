// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { focusPaneTextInputWhenReady } from "./focusPaneTextInput";

const SETTLE_MS = 500;
const WAIT_MS = 5000;

const armed: (() => void)[] = [];

function arm(pane: HTMLElement): () => void {
  const stop = focusPaneTextInputWhenReady(pane);
  armed.push(stop);
  return stop;
}

function createPane() {
  const pane = document.body.appendChild(document.createElement("div"));
  const panel = pane.appendChild(document.createElement("div"));
  panel.setAttribute("role", "tabpanel");
  const outside = document.body.appendChild(document.createElement("button"));
  return { outside, pane, panel };
}

function mountInput(panel: HTMLElement): HTMLElement {
  const input = panel.appendChild(document.createElement("div"));
  input.setAttribute("role", "textbox");
  input.setAttribute("aria-multiline", "true");
  input.tabIndex = 0;
  return input;
}

async function flushObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function useFakeTimeouts(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

afterEach(() => {
  for (const stop of armed.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("focusPaneTextInputWhenReady", () => {
  it("focuses the replacement when the input is removed right after focus", async () => {
    const { pane, panel } = createPane();
    const first = mountInput(panel);
    arm(pane);
    expect(document.activeElement).toBe(first);

    first.remove();
    await flushObserver();
    expect(document.activeElement).toBe(document.body);

    const replacement = mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(replacement);
  });

  it("focuses the replacement of an input that mounted while armed", async () => {
    const { pane, panel } = createPane();
    arm(pane);
    const first = mountInput(panel);
    await flushObserver();
    expect(document.activeElement).toBe(first);

    first.remove();
    const replacement = mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(replacement);
  });

  it("returns focus after a closing menu item briefly took it", async () => {
    const { pane, panel } = createPane();
    const input = mountInput(panel);
    arm(pane);
    const menu = document.body.appendChild(document.createElement("div"));
    menu.setAttribute("role", "menu");
    const item = menu.appendChild(document.createElement("button"));

    item.focus();
    await flushObserver();
    item.blur();
    menu.remove();
    await flushObserver();

    expect(document.activeElement).toBe(input);
  });

  it("does not take focus from a real element that already holds it", async () => {
    const { outside, pane, panel } = createPane();
    mountInput(panel);
    outside.focus();

    arm(pane);
    await flushObserver();

    expect(document.activeElement).toBe(outside);
  });

  it.each([
    [
      "pointer press",
      (outside: HTMLElement) =>
        outside.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    ],
    [
      "key press",
      (outside: HTMLElement) =>
        outside.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "a" }),
        ),
    ],
  ])("stays cancelled after a %s while waiting", async (_label, act) => {
    const { outside, pane, panel } = createPane();
    arm(pane);

    act(outside);
    mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    [
      "pointer press",
      (outside: HTMLElement) =>
        outside.dispatchEvent(new Event("pointerdown", { bubbles: true })),
      "body",
    ],
    [
      "key press",
      (outside: HTMLElement) =>
        outside.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "a" }),
        ),
      "body",
    ],
    ["focus move", (outside: HTMLElement) => outside.focus(), "outside"],
  ])(
    "does not refocus a replacement after a %s",
    async (_label, act, expected) => {
      const { outside, pane, panel } = createPane();
      const first = mountInput(panel);
      arm(pane);

      act(outside);
      first.remove();
      mountInput(panel);
      await flushObserver();

      expect(document.activeElement).toBe(
        expected === "outside" ? outside : document.body,
      );
    },
  );

  it.each([
    ["BODY", () => document.body],
    [
      "the closing menu",
      () => {
        const menu = document.body.appendChild(document.createElement("div"));
        menu.setAttribute("role", "menu");
        return menu.appendChild(document.createElement("button"));
      },
    ],
  ])("completes the move after a key press on %s", async (_label, target) => {
    const { pane, panel } = createPane();
    arm(pane);

    target().dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "a" }),
    );
    const input = mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(input);
  });

  it("stays armed after a key press in the pane input", async () => {
    const { pane, panel } = createPane();
    const first = mountInput(panel);
    arm(pane);

    first.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "a" }),
    );
    first.remove();
    const replacement = mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(replacement);
  });

  it("cancels when a key on BODY moves focus to a real element", async () => {
    const { outside, pane, panel } = createPane();
    arm(pane);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
    );
    outside.focus();
    mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(outside);
  });

  it("stops once focus has settled in the input", async () => {
    useFakeTimeouts();
    const { pane, panel } = createPane();
    const first = mountInput(panel);
    arm(pane);

    vi.advanceTimersByTime(SETTLE_MS);
    first.remove();
    mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(document.body);
  });

  it("restarts settling after focus is lost", async () => {
    useFakeTimeouts();
    const { pane, panel } = createPane();
    const first = mountInput(panel);
    arm(pane);

    vi.advanceTimersByTime(SETTLE_MS - 1);
    first.remove();
    await flushObserver();
    vi.advanceTimersByTime(SETTLE_MS);
    const replacement = mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(replacement);
  });

  it("does not take focus after the bound", async () => {
    useFakeTimeouts();
    const { pane, panel } = createPane();
    const first = mountInput(panel);
    arm(pane);
    first.remove();
    await flushObserver();

    vi.advanceTimersByTime(WAIT_MS);
    mountInput(panel);
    await flushObserver();

    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    [
      "pointer press",
      true,
      ({ outside }: { outside: HTMLElement }) =>
        outside.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    ],
    [
      "key press",
      true,
      ({ outside }: { outside: HTMLElement }) =>
        outside.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "a" }),
        ),
    ],
    [
      "focus move",
      true,
      ({ outside }: { outside: HTMLElement }) => outside.focus(),
    ],
    ["settled focus", true, () => vi.advanceTimersByTime(SETTLE_MS)],
    ["wait limit", false, () => vi.advanceTimersByTime(WAIT_MS)],
    [
      "explicit cancel",
      true,
      ({ stop }: { stop: () => void }) => {
        stop();
      },
    ],
  ])(
    "releases its observer, listeners, and timers after a %s",
    (_label, withInput, exit) => {
      useFakeTimeouts();
      const { outside, pane, panel } = createPane();
      if (withInput) mountInput(panel);
      const add = vi.spyOn(document, "addEventListener");
      const remove = vi.spyOn(document, "removeEventListener");
      const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");

      const stop = arm(pane);
      expect(add.mock.calls.length).toBeGreaterThan(0);
      exit({ outside, stop });
      stop();

      const listeners = (calls: readonly (readonly unknown[])[]) =>
        new Set(calls.map(([type, listener]) => [type, listener].join("|")));
      expect(listeners(remove.mock.calls)).toEqual(listeners(add.mock.calls));
      expect(remove.mock.calls).toHaveLength(add.mock.calls.length);
      expect(disconnect).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
