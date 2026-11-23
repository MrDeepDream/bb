import type * as MonacoNs from "monaco-editor";
import { beforeAll, vi } from "vitest";

const REAL_MONACO_HOOK_TIMEOUT_MS = 60_000;

export function beforeAllWithRealMonaco(
  setup: (monaco: typeof MonacoNs) => void | Promise<void>,
): void {
  beforeAll(async () => {
    await setup(await loadRealMonaco());
  }, REAL_MONACO_HOOK_TIMEOUT_MS);
}

async function loadRealMonaco(): Promise<typeof MonacoNs> {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    })),
  );
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const context = new Proxy(
    { measureText: () => ({ width: 0 }) },
    {
      get: (target, property) =>
        property in target
          ? target[property as keyof typeof target]
          : () => undefined,
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as never,
  );
  const monaco: unknown = await import("monaco-editor/editor/editor.api.js");
  return monaco as typeof MonacoNs;
}
