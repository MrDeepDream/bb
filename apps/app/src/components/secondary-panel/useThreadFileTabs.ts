import { useCallback, useEffect, useMemo } from "react";
import type {
  TerminalSession,
  ThreadStorageFileListResponse,
} from "@bb/server-contract";
import {
  useFixedPanelTabsState,
  useGetFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import {
  createBrowserFixedPanelTab,
  createHostFilePreviewFixedPanelTab,
  createNewTabFixedPanelTab,
  createPluginPanelFixedPanelTab,
  createPluginDetailFixedPanelTab,
  createThreadStorageFilePreviewFixedPanelTab,
  createAttachmentFilePreviewFixedPanelTab,
  createWorkspaceFilePreviewFixedPanelTab,
  type BrowserFixedPanelTab,
  type FixedPanelTab,
  type FixedPanelTabsState,
  type HostFilePreviewFixedPanelTab,
  type NewTabFixedPanelTab,
  type PluginPanelFixedPanelTab,
  type PluginDetailFixedPanelTab,
  type ThreadStorageFilePreviewFixedPanelTab,
  type AttachmentFilePreviewFixedPanelTab,
  type WorkspaceFilePreviewFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { usePluginSlotKind } from "@/lib/plugin-slots";
import { allowBrowserViewRecreation } from "./browserViewVisibilityCoordinator";
import { useFileOpenerPreferenceValue } from "@/lib/file-opener-preference";
import {
  buildFileOpenerPanelTab,
  createFileOpenerTabForRequest,
  fileOpenerIdFromActionId,
  parseFileOpenerParams,
} from "@/components/plugin/file-opener-tabs";
import {
  addToFileTabCloseBatch,
  isFileTabDirty,
  requestFileTabsClose,
} from "@/lib/file-opener-close-guard";
import { getPanelTabChrome, setPanelPreviewTab } from "./panelTabChrome";
import type { FileOpenerOverride } from "@/lib/plugin-slot-resolvers";
import type { OpenPluginPanelArgs } from "@/components/plugin/PluginPanelActions";
import type {
  HostFileTabState,
  ThreadStorageFileTabState,
  WorkspaceFileTabState,
} from "@bb/client-core";
import { useRecordThreadRecentItem } from "./threadRecentItems";
import type {
  SecondaryPanelTabReorderHandler,
  SecondaryPanelTabReorderRequest,
} from "./secondaryPanelTab";
import {
  activateSecondaryPanelTabInState,
  buildOrderedSecondaryPanelFileTabs,
  clearActiveSecondaryFileTabInState,
  closeSecondaryPanelTabInState,
  closeSecondaryPanelTabsInState,
  findSecondaryPanelTab,
  getActiveSecondaryPanelTab,
  getActiveTabIdAfterPrune,
  isBrowserTab,
  openSecondaryPanelTabInState,
  pruneStorageTabs,
  removeWorkspaceTabsForOtherEnvironments,
  replaceNewTabWithSecondaryPanelTabInState,
  reorderSecondaryPanelFileTabInState,
  setSecondaryPanelTabsInState,
  updateSecondaryPanelTabInState,
} from "@bb/client-core";
import {
  getPanelTabHistoryKey,
  rememberClosedPanelTab,
  forgetClosedPanelTab,
  takeClosedPanelTab,
  type ClosedPanelContentTab,
} from "./recentlyClosedPanelTabs";
import { forgetRemovedTabPlacement } from "./removedTabPlacements";
import { usePendingTerminalIds } from "@/components/thread/terminal/pending-terminals";
import { pruneTerminalTabsInFixedPanelState } from "./terminalPanelTabs";

interface UseThreadFileTabsParams {
  panelStateId: string | null | undefined;
  syncThreadId: string | null | undefined;
  environmentId: string | null | undefined;
  fileOwnerThreadId?: string | null;
  onCloseLastTab?: () => void;
  preserveWorkspaceTabsAcrossContexts?: boolean;
  projectHostId?: string | null;
  projectId?: string | null;
  storageFiles:
    | Pick<ThreadStorageFileListResponse, "files" | "truncated">
    | undefined;
  terminalSessions: readonly TerminalSession[] | undefined;
}

interface FileSearchWorkspaceSelection {
  source: "workspace";
  path: string;
}

interface FileSearchThreadStorageSelection {
  source: "thread-storage";
  path: string;
}

interface FileSearchHostSelection {
  source: "host";
  hostId: string | null;
  path: string;
}

export type FileSearchSelection =
  | FileSearchWorkspaceSelection
  | FileSearchThreadStorageSelection
  | FileSearchHostSelection;

export interface UpdateBrowserTabArgs {
  tabId: string;
  url: string;
  title: string | null;
}

export type OpenSecondaryPanelTabRequest =
  | {
      kind: "workspace-file-preview";
      tab: WorkspaceFileTabState;
      environmentId?: string;
    }
  | {
      kind: "host-file-preview";
      tab: HostFileTabState;
      hostId?: string;
    }
  | {
      kind: "thread-storage-file-preview";
      tab: ThreadStorageFileTabState;
      threadId?: string;
    }
  | {
      kind: "attachment-file-preview";
      name: string;
      path: string;
      projectId: string;
    }
  | { kind: "browser"; url: string }
  | { kind: "new-tab" };

interface CreateTabForOpenRequestArgs {
  projectId: string | null;
  request: OpenSecondaryPanelTabRequest;
  resolvedEnvironmentId: string | null | undefined;
  threadId: string | null | undefined;
}

type SecondaryPanelTab =
  | WorkspaceFilePreviewFixedPanelTab
  | HostFilePreviewFixedPanelTab
  | ThreadStorageFilePreviewFixedPanelTab
  | AttachmentFilePreviewFixedPanelTab
  | BrowserFixedPanelTab
  | NewTabFixedPanelTab
  | PluginPanelFixedPanelTab
  | PluginDetailFixedPanelTab;

interface StorageFileInventory {
  knownPaths: ReadonlySet<string>;
  truncated: boolean;
}

type OpenResolvedTabBehavior = "open" | "replace-new-tab";

export { resetRecentlyClosedPanelTabsForTest } from "./recentlyClosedPanelTabs";

function restoreClosedTabInState(
  state: FixedPanelTabsState,
  entry: ClosedPanelContentTab,
): FixedPanelTabsState {
  const index = Math.max(0, Math.min(entry.index, state.secondary.tabs.length));
  const tabs = [...state.secondary.tabs];
  tabs.splice(index, 0, entry.tab);
  return setSecondaryPanelTabsInState({
    activeTabId: entry.tab.id,
    isOpen: true,
    state,
    tabs,
  });
}

function isReopenableSecondaryPanelTab(
  tab: FixedPanelTab,
): tab is SecondaryPanelTab {
  switch (tab.kind) {
    case "workspace-file-preview":
    case "host-file-preview":
    case "thread-storage-file-preview":
    case "attachment-file-preview":
    case "browser":
    case "plugin-panel":
    case "plugin-detail":
    case "new-tab":
      return true;
    case "thread-info":
    case "git-diff":
    case "plugin-fixed":
    case "plugin-page-fixed":
    case "terminal":
      return false;
  }
}

function createTabForOpenRequest({
  projectId,
  request,
  resolvedEnvironmentId,
  threadId,
}: CreateTabForOpenRequestArgs): SecondaryPanelTab | null {
  switch (request.kind) {
    case "workspace-file-preview":
      if (
        request.environmentId === undefined &&
        resolvedEnvironmentId === undefined
      ) {
        return null;
      }
      const workspaceEnvironmentId =
        request.environmentId ?? resolvedEnvironmentId ?? null;
      return createWorkspaceFilePreviewFixedPanelTab({
        environmentId: workspaceEnvironmentId,
        projectId: workspaceEnvironmentId === null ? projectId : null,
        tab: request.tab,
      });
    case "host-file-preview":
      if (request.hostId !== undefined) {
        return createHostFilePreviewFixedPanelTab({
          environmentId: null,
          hostId: request.hostId,
          tab: request.tab,
          threadId: null,
        });
      }
      if (!threadId || !resolvedEnvironmentId) return null;
      return createHostFilePreviewFixedPanelTab({
        environmentId: resolvedEnvironmentId,
        tab: request.tab,
        threadId,
      });
    case "thread-storage-file-preview":
      const storageThreadId = request.threadId ?? threadId;
      if (!storageThreadId) return null;
      return createThreadStorageFilePreviewFixedPanelTab({
        environmentId: resolvedEnvironmentId ?? null,
        isPinned: false,
        tab: request.tab,
        threadId: storageThreadId,
      });
    case "attachment-file-preview":
      return createAttachmentFilePreviewFixedPanelTab({
        name: request.name,
        path: request.path,
        projectId: request.projectId,
      });
    case "browser":
      return createBrowserFixedPanelTab({
        environmentId: resolvedEnvironmentId ?? null,
        url: request.url,
      });
    case "new-tab":
      return createNewTabFixedPanelTab();
  }
}

function openRequestForFileSearchSelection(
  selection: FileSearchSelection,
): OpenSecondaryPanelTabRequest {
  if (selection.source === "workspace") {
    return {
      kind: "workspace-file-preview",
      tab: {
        lineRange: null,
        path: selection.path,
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    };
  }
  if (selection.source === "host") {
    return {
      kind: "host-file-preview",
      ...(selection.hostId === null ? {} : { hostId: selection.hostId }),
      tab: { lineRange: null, path: selection.path },
    };
  }

  return {
    kind: "thread-storage-file-preview",
    tab: {
      lineRange: null,
      path: selection.path,
    },
  };
}

function applyPrunedSecondaryTabs(
  state: FixedPanelTabsState,
  tabs: readonly FixedPanelTab[],
): FixedPanelTabsState {
  return setSecondaryPanelTabsInState({
    activeTabId: getActiveTabIdAfterPrune(tabs, state.secondary.activeTabId),
    isOpen: state.secondary.isOpen,
    state,
    tabs,
  });
}

export function useThreadFileTabs({
  panelStateId,
  syncThreadId,
  environmentId,
  fileOwnerThreadId,
  onCloseLastTab,
  preserveWorkspaceTabsAcrossContexts = false,
  projectHostId = null,
  projectId = null,
  storageFiles,
  terminalSessions,
}: UseThreadFileTabsParams) {
  const fixedPanelTabsState = useFixedPanelTabsState(
    panelStateId,
    syncThreadId,
  );
  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(
    panelStateId,
    syncThreadId,
  );
  const recordRecentItem = useRecordThreadRecentItem(panelStateId);
  const resolvedPanelStateId =
    typeof panelStateId === "string" && panelStateId.length > 0
      ? panelStateId
      : null;
  const isPanelStateResolved = resolvedPanelStateId !== null;
  const resolvedFileOwnerThreadId =
    fileOwnerThreadId !== undefined
      ? fileOwnerThreadId
      : (syncThreadId ?? null);
  const resolvedEnvironmentId = isPanelStateResolved
    ? environmentId
    : undefined;
  const storageInventory = useMemo<StorageFileInventory | null>(
    () =>
      storageFiles === undefined
        ? null
        : {
            knownPaths: new Set(storageFiles.files.map((file) => file.path)),
            truncated: storageFiles.truncated,
          },
    [storageFiles],
  );
  const recentlyClosedPanelContextKey = getPanelTabHistoryKey({
    environmentId: resolvedEnvironmentId,
    fileOwnerThreadId: resolvedFileOwnerThreadId,
    panelStateId: resolvedPanelStateId,
    projectHostId,
    projectId,
  });

  useEffect(() => {
    if (!resolvedFileOwnerThreadId) return;
    updateFixedPanelTabsState((state) => {
      let didChange = false;
      const tabIdMap = new Map<string, string>();
      const seenTabIds = new Set<string>();
      const tabs: FixedPanelTab[] = [];
      for (const tab of state.secondary.tabs) {
        let nextTab = tab;
        if (
          tab.kind === "host-file-preview" &&
          tab.threadId === null &&
          resolvedEnvironmentId
        ) {
          nextTab = createHostFilePreviewFixedPanelTab({
            environmentId: resolvedEnvironmentId,
            hostId: tab.hostId,
            tab: {
              lineRange: tab.lineRange,
              path: tab.path,
            },
            threadId: resolvedFileOwnerThreadId,
          });
          didChange = true;
          tabIdMap.set(tab.id, nextTab.id);
        } else if (
          tab.kind === "thread-storage-file-preview" &&
          tab.threadId === null
        ) {
          nextTab = createThreadStorageFilePreviewFixedPanelTab({
            environmentId: tab.environmentId ?? resolvedEnvironmentId ?? null,
            isPinned: tab.isPinned,
            tab: {
              lineRange: tab.lineRange,
              path: tab.path,
            },
            threadId: resolvedFileOwnerThreadId,
          });
          didChange = true;
          tabIdMap.set(tab.id, nextTab.id);
        }
        if (seenTabIds.has(nextTab.id)) {
          didChange = true;
          tabIdMap.set(tab.id, nextTab.id);
          continue;
        }
        seenTabIds.add(nextTab.id);
        tabs.push(nextTab);
      }
      if (!didChange) return state;
      const activeTabId =
        state.secondary.activeTabId === null
          ? null
          : (tabIdMap.get(state.secondary.activeTabId) ??
            state.secondary.activeTabId);
      return setSecondaryPanelTabsInState({
        activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs,
      });
    });
  }, [
    resolvedEnvironmentId,
    resolvedFileOwnerThreadId,
    updateFixedPanelTabsState,
  ]);

  useEffect(() => {
    if (preserveWorkspaceTabsAcrossContexts) return;
    if (resolvedEnvironmentId === undefined) return;
    updateFixedPanelTabsState((state) =>
      applyPrunedSecondaryTabs(
        state,
        removeWorkspaceTabsForOtherEnvironments(
          state.secondary.tabs,
          resolvedEnvironmentId,
        ),
      ),
    );
  }, [
    preserveWorkspaceTabsAcrossContexts,
    resolvedEnvironmentId,
    updateFixedPanelTabsState,
  ]);

  useEffect(() => {
    if (
      !isPanelStateResolved ||
      storageInventory === null ||
      storageInventory.truncated
    ) {
      return;
    }
    updateFixedPanelTabsState((state) =>
      applyPrunedSecondaryTabs(
        state,
        pruneStorageTabs({
          knownPaths: storageInventory.knownPaths,
          tabs: state.secondary.tabs,
          threadId: resolvedFileOwnerThreadId,
        }),
      ),
    );
  }, [
    isPanelStateResolved,
    resolvedFileOwnerThreadId,
    storageInventory,
    updateFixedPanelTabsState,
  ]);

  const pendingTerminalIds = usePendingTerminalIds();
  useEffect(() => {
    if (!isPanelStateResolved || terminalSessions === undefined) return;
    updateFixedPanelTabsState((state) =>
      pruneTerminalTabsInFixedPanelState({
        pendingTerminalIds,
        state,
        terminalSessions,
      }),
    );
  }, [
    isPanelStateResolved,
    pendingTerminalIds,
    terminalSessions,
    updateFixedPanelTabsState,
  ]);

  const fileOpeners = usePluginSlotKind("fileOpeners");
  const fileOpenerPreference = useFileOpenerPreferenceValue();

  const openResolvedTab = useCallback(
    (
      request: OpenSecondaryPanelTabRequest,
      behavior: OpenResolvedTabBehavior,
      viewer?: FileOpenerOverride,
    ): SecondaryPanelTab | null => {
      const openerTab = createFileOpenerTabForRequest({
        fileOpeners,
        preference: fileOpenerPreference,
        projectHostId,
        projectId,
        request,
        resolvedEnvironmentId,
        threadId: resolvedFileOwnerThreadId,
        ...(viewer !== undefined ? { viewer } : {}),
      });
      const tab =
        openerTab ??
        createTabForOpenRequest({
          projectId,
          request,
          resolvedEnvironmentId,
          threadId: resolvedFileOwnerThreadId,
        });
      if (tab === null) return null;

      if (recentlyClosedPanelContextKey !== null) {
        forgetClosedPanelTab(recentlyClosedPanelContextKey, tab.id);
      }

      if (
        request.kind === "workspace-file-preview" &&
        request.tab.source.kind === "working-tree"
      ) {
        recordRecentItem({ source: "workspace", path: request.tab.path });
      }
      if (request.kind === "thread-storage-file-preview") {
        recordRecentItem({ source: "thread-storage", path: request.tab.path });
      }
      if (request.kind === "host-file-preview") {
        recordRecentItem({
          source: "host",
          hostId: request.hostId ?? null,
          path: request.tab.path,
        });
      }

      const opensPreview =
        openerTab !== null &&
        resolvedPanelStateId !== null &&
        fileOpeners.some(
          (opener) =>
            opener.pluginId === openerTab.pluginId &&
            opener.id === fileOpenerIdFromActionId(openerTab.actionId) &&
            opener.experimental_closeGuard !== undefined,
        );
      const chrome = getPanelTabChrome(resolvedPanelStateId);
      let isNewPreview = false;
      updateFixedPanelTabsState((state) => {
        const isExisting =
          findSecondaryPanelTab(state.secondary.tabs, tab.id) !== null;
        if (!isExisting) {
          forgetRemovedTabPlacement(resolvedPanelStateId, tab.id);
        }
        isNewPreview = opensPreview && !isExisting;
        const replacedPreviewId = chrome.previewTabId;
        const base =
          isNewPreview &&
          replacedPreviewId !== null &&
          !chrome.pinnedTabIds.includes(replacedPreviewId) &&
          !isFileTabDirty(replacedPreviewId)
            ? closeSecondaryPanelTabInState(state, replacedPreviewId)
            : state;
        if (behavior === "replace-new-tab") {
          return replaceNewTabWithSecondaryPanelTabInState({
            state: base,
            tab,
          });
        }
        return openSecondaryPanelTabInState({ state: base, tab });
      });
      if (isNewPreview && resolvedPanelStateId !== null) {
        setPanelPreviewTab(resolvedPanelStateId, tab.id);
      }
      return tab;
    },
    [
      fileOpenerPreference,
      fileOpeners,
      projectHostId,
      recordRecentItem,
      projectId,
      resolvedEnvironmentId,
      resolvedFileOwnerThreadId,
      resolvedPanelStateId,
      recentlyClosedPanelContextKey,
      updateFixedPanelTabsState,
    ],
  );

  const openFileTabView = useCallback(
    (tabId: string): string | null => {
      let viewTabId: string | null = null;
      updateFixedPanelTabsState((state) => {
        const tab = findSecondaryPanelTab(state.secondary.tabs, tabId);
        if (tab?.kind !== "plugin-panel" || !tab.fileOpenerOwner) return state;
        const openerId = fileOpenerIdFromActionId(tab.actionId);
        const file = parseFileOpenerParams(tab.paramsJson);
        if (openerId === null || file === null) return state;
        const openTabIds = new Set(state.secondary.tabs.map(({ id }) => id));
        const opener = { id: openerId, pluginId: tab.pluginId };
        let view = 2;
        let clone = buildFileOpenerPanelTab(
          opener,
          file,
          tab.fileOpenerOwner,
          view,
        );
        while (openTabIds.has(clone.id)) {
          view += 1;
          clone = buildFileOpenerPanelTab(
            opener,
            file,
            tab.fileOpenerOwner,
            view,
          );
        }
        viewTabId = clone.id;
        forgetRemovedTabPlacement(resolvedPanelStateId, clone.id);
        return openSecondaryPanelTabInState({ state, tab: clone });
      });
      if (viewTabId !== null && resolvedPanelStateId !== null) {
        if (getPanelTabChrome(resolvedPanelStateId).previewTabId === tabId) {
          setPanelPreviewTab(resolvedPanelStateId, null);
        }
      }
      return viewTabId;
    },
    [resolvedPanelStateId, updateFixedPanelTabsState],
  );

  const openTab = useCallback(
    (
      request: OpenSecondaryPanelTabRequest,
      options?: { viewer?: FileOpenerOverride },
    ): SecondaryPanelTab | null => {
      return openResolvedTab(
        request,
        request.kind === "browser" ? "replace-new-tab" : "open",
        options?.viewer,
      );
    },
    [openResolvedTab],
  );

  const activateTab = useCallback(
    (tabId: string) => {
      updateFixedPanelTabsState((state) =>
        activateSecondaryPanelTabInState(state, tabId),
      );
    },
    [updateFixedPanelTabsState],
  );

  const getFixedPanelTabsState = useGetFixedPanelTabsState(panelStateId);

  const closeTabs = useCallback(
    (tabIds: readonly string[], options?: { remember: boolean }) => {
      requestFileTabsClose({
        tabIds,
        panelTabIds: getFixedPanelTabsState().secondary.tabs.map(
          (tab) => tab.id,
        ),
        perform: () => {
          let didCloseLastTab = false;
          updateFixedPanelTabsState((state) => {
            const next = closeSecondaryPanelTabsInState(state, tabIds);
            didCloseLastTab =
              next !== state && next.secondary.tabs.length === 0;
            if (
              next !== state &&
              recentlyClosedPanelContextKey !== null &&
              options?.remember !== false
            ) {
              const closing = new Set(tabIds);
              state.secondary.tabs.forEach((tab, index) => {
                if (closing.has(tab.id) && isReopenableSecondaryPanelTab(tab)) {
                  rememberClosedPanelTab(recentlyClosedPanelContextKey, {
                    kind: "content",
                    index,
                    tab,
                  });
                }
              });
            }
            return next;
          });
          if (didCloseLastTab) onCloseLastTab?.();
        },
      });
    },
    [
      getFixedPanelTabsState,
      onCloseLastTab,
      recentlyClosedPanelContextKey,
      updateFixedPanelTabsState,
    ],
  );

  const closeTab = useCallback(
    (tabId: string, options?: { remember: boolean }) => {
      if (options === undefined && addToFileTabCloseBatch(closeTabs, tabId)) {
        return;
      }
      closeTabs([tabId], options);
    },
    [closeTabs],
  );

  const closeTabNow = useCallback(
    (tabId: string) => closeTabs([tabId]),
    [closeTabs],
  );

  const reopenClosedTab = useCallback((): boolean => {
    if (recentlyClosedPanelContextKey === null) return false;
    const contextKey = recentlyClosedPanelContextKey;
    let didReopen = false;
    updateFixedPanelTabsState((state) => {
      const entry = takeClosedPanelTab(
        contextKey,
        new Set(state.secondary.tabs.map((tab) => tab.id)),
      );
      if (entry === null) return state;
      didReopen = true;
      if (entry.tab.kind === "browser" && entry.tab.desktopTarget) {
        allowBrowserViewRecreation(entry.tab.id, entry.tab.desktopTarget);
      }
      return restoreClosedTabInState(state, entry);
    });
    return didReopen;
  }, [recentlyClosedPanelContextKey, updateFixedPanelTabsState]);

  const openPluginDetail = useCallback(
    ({ detailKey, title }: { detailKey: string; title: string }) => {
      const tab = createPluginDetailFixedPanelTab({ detailKey, title });
      if (recentlyClosedPanelContextKey !== null) {
        forgetClosedPanelTab(recentlyClosedPanelContextKey, tab.id);
      }
      updateFixedPanelTabsState((state) => {
        const existing = findSecondaryPanelTab(state.secondary.tabs, tab.id);
        if (existing === null) {
          forgetRemovedTabPlacement(resolvedPanelStateId, tab.id);
        }
        return replaceNewTabWithSecondaryPanelTabInState({
          state,
          tab: existing ?? tab,
        });
      });
      return tab;
    },
    [
      recentlyClosedPanelContextKey,
      resolvedPanelStateId,
      updateFixedPanelTabsState,
    ],
  );

  const openPluginPanel = useCallback(
    ({ pluginId, actionId, title, paramsJson }: OpenPluginPanelArgs) => {
      const tab = createPluginPanelFixedPanelTab({
        actionId,
        paramsJson,
        pluginId,
        title,
      });
      if (recentlyClosedPanelContextKey !== null) {
        forgetClosedPanelTab(recentlyClosedPanelContextKey, tab.id);
      }
      updateFixedPanelTabsState((state) => {
        const existing = findSecondaryPanelTab(state.secondary.tabs, tab.id);
        if (existing !== null && existing.kind === "plugin-panel") {
          const withTitle =
            existing.title === title
              ? state
              : updateSecondaryPanelTabInState({
                  state,
                  tab: { ...existing, title },
                });
          return replaceNewTabWithSecondaryPanelTabInState({
            state: withTitle,
            tab: existing,
          });
        }
        forgetRemovedTabPlacement(resolvedPanelStateId, tab.id);
        return replaceNewTabWithSecondaryPanelTabInState({ state, tab });
      });
    },
    [
      recentlyClosedPanelContextKey,
      resolvedPanelStateId,
      updateFixedPanelTabsState,
    ],
  );

  const selectFileSearchResult = useCallback(
    (selection: FileSearchSelection) => {
      openResolvedTab(
        openRequestForFileSearchSelection(selection),
        "replace-new-tab",
      );
    },
    [openResolvedTab],
  );

  const updateBrowserTab = useCallback(
    ({ tabId, url, title }: UpdateBrowserTabArgs) => {
      updateFixedPanelTabsState((state) => {
        const tab = findSecondaryPanelTab(state.secondary.tabs, tabId);
        if (!tab || !isBrowserTab(tab)) {
          return state;
        }
        return updateSecondaryPanelTabInState({
          state,
          tab: {
            ...tab,
            title,
            url,
          },
        });
      });
    },
    [updateFixedPanelTabsState],
  );

  const clearActiveFileTabs = useCallback(() => {
    updateFixedPanelTabsState(clearActiveSecondaryFileTabInState);
  }, [updateFixedPanelTabsState]);

  const reorderTab = useCallback<SecondaryPanelTabReorderHandler>(
    (request: SecondaryPanelTabReorderRequest) => {
      updateFixedPanelTabsState((state) =>
        reorderSecondaryPanelFileTabInState({ ...request, state }),
      );
    },
    [updateFixedPanelTabsState],
  );

  const activeTab = getActiveSecondaryPanelTab(fixedPanelTabsState);
  const orderedSecondaryFileTabs = buildOrderedSecondaryPanelFileTabs({
    includeWorkspaceTabsOutsideEnvironment: preserveWorkspaceTabsAcrossContexts,
    tabs: fixedPanelTabsState.secondary.tabs,
    resolvedEnvironmentId,
  });
  const browserTabs = useMemo(
    () => fixedPanelTabsState.secondary.tabs.filter(isBrowserTab),
    [fixedPanelTabsState.secondary.tabs],
  );
  const activeWorkspaceFileTab =
    activeTab?.kind === "workspace-file-preview" &&
    (preserveWorkspaceTabsAcrossContexts ||
      activeTab.environmentId === resolvedEnvironmentId)
      ? activeTab
      : null;
  const activeStorageFileTab =
    activeTab?.kind === "thread-storage-file-preview" ? activeTab : null;
  const activeHostFileTab =
    activeTab?.kind === "host-file-preview" ? activeTab : null;
  const activeBrowserTab = activeTab?.kind === "browser" ? activeTab : null;
  const activePluginPanelTab =
    activeTab?.kind === "plugin-panel" ? activeTab : null;
  const activeFileOpenerOwner =
    activePluginPanelTab !== null &&
    fileOpenerIdFromActionId(activePluginPanelTab.actionId) !== null
      ? (activePluginPanelTab.fileOpenerOwner ?? null)
      : null;
  const activeFileOpenerFile =
    activeFileOpenerOwner === null || activePluginPanelTab === null
      ? null
      : parseFileOpenerParams(activePluginPanelTab.paramsJson);
  const activeWorkspaceFileOpener =
    activeFileOpenerOwner?.kind === "workspace-file-preview" &&
    activeFileOpenerFile?.source.kind === "workspace"
      ? activeFileOpenerFile
      : null;
  const activeHostFileOpener =
    activeFileOpenerOwner?.kind === "host-file-preview" &&
    activeFileOpenerFile?.source.kind === "host"
      ? activeFileOpenerFile
      : null;
  const activeStorageFileOpener =
    activeFileOpenerOwner?.kind === "thread-storage-file-preview" &&
    activeFileOpenerFile?.source.kind === "thread-storage"
      ? activeFileOpenerFile
      : null;

  return {
    activateTab,
    activeBrowserTab,
    activeHostFileLineRange:
      activeHostFileTab?.lineRange ??
      (activeFileOpenerOwner?.kind === "host-file-preview"
        ? activeFileOpenerOwner.tab.lineRange
        : null),
    activeHostFilePath:
      activeHostFileTab?.path ?? activeHostFileOpener?.path ?? null,
    activeStorageFilePath:
      activeStorageFileTab?.path ?? activeStorageFileOpener?.path ?? null,
    activeWorkspaceFilePath:
      activeWorkspaceFileTab?.path ?? activeWorkspaceFileOpener?.path ?? null,
    browserTabs,
    clearActiveFileTabs,
    closeTab,
    closeTabNow,
    openFileTabView,
    openPluginDetail,
    openPluginPanel,
    openTab,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
    selectFileSearchResult,
    updateBrowserTab,
  };
}
