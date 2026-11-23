import { useCallback } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { z } from "zod";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";
import { hasThreadId } from "@/lib/thread-id";

const THREAD_RECENT_ITEMS_STORAGE_PREFIX = "bb.thread.recentItems";
const THREAD_RECENT_ITEMS_STORAGE_VERSION = 1;
const THREAD_RECENT_ITEMS_MAX_STORED = 24;
export const THREAD_RECENT_ITEMS_VISIBLE_LIMIT = 6;

type RecentItemTarget =
  | { source: "workspace" | "thread-storage"; path: string }
  | { source: "host"; hostId: string | null; path: string };

export type ThreadRecentItem = RecentItemTarget & { openedAt: number };

type RecordRecentItemArgs = RecentItemTarget & {
  items: readonly ThreadRecentItem[];
  openedAt: number;
  limit?: number;
};

interface ThreadRecentItemsStorageKeyArgs {
  threadId: string;
}

const recentItemSchema = z.union([
  z
    .object({
      source: z.enum(["workspace", "thread-storage"]),
      path: z.string().min(1),
      openedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      source: z.literal("host"),
      hostId: z.string().min(1).nullable(),
      path: z.string().min(1),
      openedAt: z.number().int().nonnegative(),
    })
    .strict(),
]);

const recentItemsSchema = z.array(recentItemSchema);

const EMPTY_RECENT_ITEMS: readonly ThreadRecentItem[] = [];

function isSameRecentTarget(
  item: RecentItemTarget,
  target: RecentItemTarget,
): boolean {
  if (item.source !== target.source || item.path !== target.path) return false;
  return (
    item.source !== "host" ||
    target.source !== "host" ||
    item.hostId === target.hostId
  );
}

export function recordRecentItem({
  items,
  openedAt,
  limit = THREAD_RECENT_ITEMS_MAX_STORED,
  ...target
}: RecordRecentItemArgs): ThreadRecentItem[] {
  const withoutExisting = items.filter(
    (item) => !isSameRecentTarget(item, target),
  );
  return [{ ...target, openedAt }, ...withoutExisting].slice(0, limit);
}

const recentItemsStorage = createLocalStorageSyncStorage<
  readonly ThreadRecentItem[]
>({
  parse: (storedValue, initialValue) => {
    if (storedValue === null) {
      return initialValue;
    }
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(storedValue);
    } catch {
      return initialValue;
    }
    const result = recentItemsSchema.safeParse(parsedValue);
    if (!result.success) {
      return initialValue;
    }
    return result.data.slice(0, THREAD_RECENT_ITEMS_MAX_STORED);
  },
  serialize: (value) => JSON.stringify(value),
});

export function getThreadRecentItemsStorageKey({
  threadId,
}: ThreadRecentItemsStorageKeyArgs): string {
  return `${THREAD_RECENT_ITEMS_STORAGE_PREFIX}-${encodeURIComponent(
    threadId,
  )}-${THREAD_RECENT_ITEMS_STORAGE_VERSION}`;
}

const disabledThreadRecentItemsAtom =
  atom<readonly ThreadRecentItem[]>(EMPTY_RECENT_ITEMS);

const threadRecentItemsAtomFamily = atomFamily((threadId: string) =>
  atomWithStorage<readonly ThreadRecentItem[]>(
    getThreadRecentItemsStorageKey({ threadId }),
    EMPTY_RECENT_ITEMS,
    recentItemsStorage,
    { getOnInit: true },
  ),
);

function getThreadRecentItemsAtom(threadId: string | null | undefined) {
  return hasThreadId(threadId)
    ? threadRecentItemsAtomFamily(threadId)
    : disabledThreadRecentItemsAtom;
}

export function useThreadRecentItems(
  threadId: string | null | undefined,
): readonly ThreadRecentItem[] {
  return useAtomValue(getThreadRecentItemsAtom(threadId));
}

export function useRecordThreadRecentItem(
  threadId: string | null | undefined,
): (target: RecentItemTarget) => void {
  const setRecentItems = useSetAtom(getThreadRecentItemsAtom(threadId));
  return useCallback(
    (target: RecentItemTarget) => {
      if (!hasThreadId(threadId)) {
        return;
      }
      setRecentItems((items) =>
        recordRecentItem({ ...target, items, openedAt: Date.now() }),
      );
    },
    [setRecentItems, threadId],
  );
}
