// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginPanelFixedPanelTab,
  type PluginPanelFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { usePanelTabPresenter } from "./usePanelTabPresenter";

vi.mock("@/hooks/queries/plugin-settings-queries", () => ({
  usePluginList: () => ({ data: undefined }),
}));

vi.mock("@/hooks/queries/plugin-catalog-queries", () => ({
  usePluginCatalogSearch: () => ({ data: undefined }),
}));

afterEach(cleanup);

function panelTab(title: string): PluginPanelFixedPanelTab {
  return createPluginPanelFixedPanelTab({
    actionId: "file-opener:monaco",
    paramsJson: null,
    pluginId: "monaco-editor",
    title,
  });
}

function fileOpenerTab(title: string, path: string): PluginPanelFixedPanelTab {
  return {
    ...panelTab(title),
    fileOpenerOwner: {
      kind: "host-file-preview",
      environmentId: null,
      hostId: "host_1",
      tab: { lineRange: null, path },
      threadId: null,
    },
  };
}

function presentLabel(tab: PluginPanelFixedPanelTab): string {
  const { result } = renderHook(() =>
    usePanelTabPresenter({
      tabs: [tab],
      terminalsById: new Map(),
      pluginActions: [],
    }),
  );
  return result.current(tab).label;
}

describe("usePanelTabPresenter file opener labels", () => {
  it.each([
    ["C:\\Users\\dev\\project\\f04.ts", "f04.ts"],
    ["\\\\server\\share\\project\\f04.ts", "f04.ts"],
    ["f04.ts", "f04.ts"],
    ["odd\\name.ts", "odd\\name.ts"],
  ])("shows a saved title %s as %s", (title, label) => {
    expect(presentLabel(fileOpenerTab(title, title))).toBe(label);
  });

  it("keeps the title of a plugin panel that is not a file", () => {
    expect(presentLabel(panelTab("C:\\Reports\\Summary"))).toBe(
      "C:\\Reports\\Summary",
    );
  });
});
