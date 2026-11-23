import {
  cliCommand,
  defineCli,
  PluginCliError,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  DEFAULT_SEARCH_MATCHES,
  MAX_SEARCH_MATCHES,
  type SearchPage,
} from "./host-contract.js";
import type {
  fileSchema,
  searchRequestSchema,
  searchStartOutputSchema,
} from "./rpc-contract.js";

type SearchApi = {
  start(
    input: z.output<typeof searchRequestSchema>,
  ): Promise<z.output<typeof searchStartOutputSchema>>;
  next(searchId: string, signal?: AbortSignal): Promise<SearchPage>;
  cancel(searchId: string): Promise<void>;
  threadEnvironment(threadId: string): Promise<string | null>;
};

type SearchTargetOptions = {
  environment: string | undefined;
  project: string | undefined;
  host: string | undefined;
};

const TRUNCATED_NOTICE: Record<NonNullable<SearchPage["truncated"]>, string> = {
  limit: "Stopped at the match limit.",
  bytes: "Stopped at the result size limit.",
  time: "Stopped at the time limit.",
};

async function resolveSearchFile(
  options: SearchTargetOptions,
  ctx: PluginCliContext,
  threadEnvironment: SearchApi["threadEnvironment"],
): Promise<z.output<typeof fileSchema>> {
  const fromThread =
    options.environment === undefined &&
    options.project === undefined &&
    ctx.threadId !== undefined
      ? await threadEnvironment(ctx.threadId)
      : null;
  const environmentId = options.environment ?? fromThread;
  if (environmentId !== null) {
    return {
      path: ".",
      source: {
        kind: "workspace",
        threadId: null,
        environmentId,
        projectId: null,
      },
    };
  }
  const projectId = options.project ?? ctx.projectId;
  if (projectId === undefined) {
    throw new PluginCliError("No search target.", {
      code: "missing_target",
      hint: "Pass --environment <id> or --project <id>.",
    });
  }
  return {
    path: ".",
    source: {
      kind: "workspace",
      threadId: null,
      environmentId: null,
      projectId,
      ...(options.host === undefined
        ? {}
        : { experimental_hostId: options.host }),
    },
  };
}

export function createSearchCli(search: SearchApi) {
  return defineCli({
    name: "editor",
    summary: "Search project files with the File Editor plugin",
    commands: {
      search: cliCommand({
        summary: "Find text in saved files, honoring .gitignore",
        description:
          "Searches an environment or project root. Put a query that starts with a dash after --.",
        positionals: [
          { name: "query", description: "Text to find", required: true },
        ],
        options: {
          regex: {
            type: "boolean",
            description: "Treat the query as a POSIX extended regex",
          },
          "case-sensitive": {
            type: "boolean",
            description: "Match letter case exactly",
          },
          limit: {
            type: "integer",
            min: 1,
            max: MAX_SEARCH_MATCHES,
            default: DEFAULT_SEARCH_MATCHES,
            description: "Maximum matching lines to return",
          },
          environment: {
            type: "string",
            description: "Environment to search",
          },
          project: { type: "string", description: "Project to search" },
          host: {
            type: "string",
            description: "Host of the project checkout to search",
          },
          json: {
            type: "boolean",
            description: "Print machine-readable JSON output",
          },
        },
        constraints: [
          { kind: "at-most-one", options: ["environment", "project"] },
          { kind: "requires", option: "host", needs: ["project"] },
        ],
        async run(input, ctx) {
          const file = await resolveSearchFile(
            input.options,
            ctx,
            search.threadEnvironment,
          );
          const started = await search.start({
            file,
            query: input.positionals.query,
            mode: input.options.regex ? "regex" : "literal",
            caseSensitive: input.options["case-sensitive"],
            limit: input.options.limit,
          });
          if (started.kind === "unavailable") {
            throw new PluginCliError(started.reason, {
              code: "no_search_root",
            });
          }
          const files = new Map<
            string,
            SearchPage["files"][number]["matches"]
          >();
          let last: SearchPage;
          try {
            do {
              ctx.signal?.throwIfAborted();
              last = await search.next(started.searchId, ctx.signal);
              for (const { path, matches } of last.files) {
                const existing = files.get(path);
                if (existing === undefined) files.set(path, [...matches]);
                else existing.push(...matches);
              }
            } while (last.status === "running");
          } catch (error) {
            await search.cancel(started.searchId).catch(() => undefined);
            throw error;
          }
          if (last.status === "expired") {
            throw new PluginCliError("The search session expired.", {
              code: "search_expired",
            });
          }
          if (last.error !== null) {
            throw new PluginCliError(last.error, { code: "search_failed" });
          }
          if (input.options.json) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({
                root: started.root,
                matchCount: last.matchCount,
                truncated: last.truncated,
                files: [...files].map(([path, matches]) => ({ path, matches })),
              })}\n`,
            };
          }
          const lines: string[] = [];
          for (const [path, matches] of files) {
            for (const match of matches) {
              lines.push(
                `${path}:${match.line}:${match.column}: ${match.text}`,
              );
            }
          }
          const notice =
            last.truncated === null
              ? ""
              : `${TRUNCATED_NOTICE[last.truncated]}\n`;
          return {
            exitCode: 0,
            stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
            ...(notice === "" ? {} : { stderr: notice }),
          };
        },
      }),
    },
  });
}
