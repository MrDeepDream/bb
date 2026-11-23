import fs from "node:fs/promises";
import path from "node:path";
import {
  experimental_defineHostEntry,
  type ExperimentalHostWatchEvent,
  type ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import { monacoHostContract, monacoHostSignals } from "./lib/host-contract.js";
import { createSearchSessions, isRepositoryRoot } from "./lib/host-search.js";

const OWN_WRITE_PREFIX = ".bb-write-";

const IGNORED_WATCH_PATHS = [".git", "node_modules"];

const watches = new Map<string, Promise<ExperimentalHostWatchSubscription>>();

const searches = createSearchSessions();

export function isOwnWriteOnlyEvent(
  event: ExperimentalHostWatchEvent,
): boolean {
  return (
    event.kind === "changed" &&
    event.changes.every((change) =>
      path.basename(change.path).startsWith(OWN_WRITE_PREFIX),
    )
  );
}

async function fingerprint(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : null;
  } catch {
    return null;
  }
}

export default experimental_defineHostEntry({
  contract: monacoHostContract,
  experimental_signals: monacoHostSignals,
  handlers: {
    async fingerprints({ paths }) {
      const values = await Promise.all(paths.map(fingerprint));
      return Object.fromEntries(
        paths.map((filePath, index) => [filePath, values[index] ?? null]),
      );
    },
    isRepositoryRoot: ({ rootPath }, context) =>
      isRepositoryRoot(rootPath, context.signal),
    async watchRoot({ rootPath }, context) {
      if (watches.has(rootPath)) {
        await watches.get(rootPath);
        return null;
      }
      const subscription = context.experimental_watch(
        { rootPath, ignoredPaths: IGNORED_WATCH_PATHS },
        async (event) => {
          if (isOwnWriteOnlyEvent(event)) return;
          await context.experimental_emitSignal("rootChanged", { rootPath });
        },
      );
      watches.set(rootPath, subscription);
      try {
        await subscription;
      } catch (error) {
        watches.delete(rootPath);
        throw error;
      }
      return null;
    },
    async unwatchRoot({ rootPath }) {
      const subscription = watches.get(rootPath);
      if (subscription === undefined) return null;
      watches.delete(rootPath);
      await (await subscription).dispose();
      return null;
    },
    searchStart: (input) => searches.start(input),
    searchNext: ({ searchId }, context) =>
      searches.next(searchId, context.signal),
    searchCancel: ({ searchId }) => {
      searches.cancel(searchId);
      return null;
    },
  },
  dispose: async () => {
    searches.dispose();
    const subscriptions = [...watches.values()];
    watches.clear();
    await Promise.allSettled(
      subscriptions.map(async (subscription) => (await subscription).dispose()),
    );
  },
});
