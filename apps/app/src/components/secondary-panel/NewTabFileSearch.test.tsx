// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POINTER_COARSE_QUERY } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { NewTabFileSearch } from "./NewTabFileSearch";
import type { ThreadRecentItem } from "./threadRecentItems";

const recentItems = vi.hoisted(() => ({
  current: [] as readonly ThreadRecentItem[],
}));

vi.mock("@/hooks/useFileSearchSuggestions", () => ({
  useFileSearchSuggestions: () => ({
    suggestions: [],
    isLoading: false,
    fileSearchError: false,
    isDebouncing: false,
    isUnavailable: false,
  }),
}));

vi.mock("./threadRecentItems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./threadRecentItems")>();
  return {
    ...actual,
    useThreadRecentItems: () => recentItems.current,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  recentItems.current = [];
});

function mockPointerCoarse(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === POINTER_COARSE_QUERY && matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function renderFileSearch({
  autoFocus,
  onAutoFocusHandled = () => undefined,
}: {
  autoFocus: boolean;
  onAutoFocusHandled?: () => void;
}) {
  render(
    <NewTabFileSearch
      autoFocus={autoFocus}
      projectId="proj_1"
      environmentId="env_1"
      currentThreadId="thr_1"
      actions={[]}
      onAutoFocusHandled={onAutoFocusHandled}
      onSelect={() => {}}
    />,
  );
}

describe("NewTabFileSearch", () => {
  it("does not autofocus when passively remounted", () => {
    mockPointerCoarse(false);
    const focusSpy = vi
      .spyOn(HTMLInputElement.prototype, "focus")
      .mockImplementation(() => {});

    renderFileSearch({ autoFocus: false });

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("consumes an explicit request without focusing on coarse pointers", () => {
    mockPointerCoarse(true);
    const focusSpy = vi
      .spyOn(HTMLInputElement.prototype, "focus")
      .mockImplementation(() => {});
    const onAutoFocusHandled = vi.fn();

    renderFileSearch({ autoFocus: true, onAutoFocusHandled });

    expect(focusSpy).not.toHaveBeenCalled();
    expect(onAutoFocusHandled).toHaveBeenCalledTimes(1);
  });

  it("autofocuses for an explicit request and consumes it", () => {
    mockPointerCoarse(false);
    const focusSpy = vi
      .spyOn(HTMLInputElement.prototype, "focus")
      .mockImplementation(() => {});
    const onAutoFocusHandled = vi.fn();
    let nextFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });

    renderFileSearch({ autoFocus: true, onAutoFocusHandled });

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(onAutoFocusHandled).toHaveBeenCalledTimes(1);

    act(() => nextFrame?.(0));

    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      path: "C:\\Users\\dev\\project\\src\\f04.ts",
      directory: "C:\\Users\\dev\\project\\src",
    },
    { path: "/home/dev/project/f04.ts", directory: "/home/dev/project" },
  ])("shows the recent host file $path by name", ({ path, directory }) => {
    mockPointerCoarse(false);
    recentItems.current = [{ source: "host", hostId: null, path, openedAt: 1 }];

    renderFileSearch({ autoFocus: false });

    const row = screen.getByTitle(path);
    expect(within(row).getByText("f04.ts")).toBeTruthy();
    expect(row.textContent).toContain(directory);
  });
});
