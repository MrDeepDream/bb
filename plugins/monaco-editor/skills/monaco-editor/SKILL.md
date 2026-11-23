---
name: monaco-editor
description: "Search the saved files of an environment or project from the bb CLI or SDK with the File Editor plugin, honoring .gitignore."
---

# File Editor

The plugin searches a workspace or project root with `git grep` on the machine
that holds the files. The editor's Find in Files panel uses the same search.

```sh
bb editor search <query> [--regex] [--case-sensitive] [--limit <n>] [--json]
bb editor search <query> --environment <id>
bb editor search <query> --project <id> [--host <id>]
bb editor search -- -query-with-leading-dash
```

- With no target, the command searches the current thread's environment, then
  the context project.
- The query is literal and case-insensitive by default. `--regex` uses POSIX
  extended syntax; Perl syntax is not available.
- The search reads saved files, so unsaved editor text is not searched. It
  covers tracked and untracked files, and skips `.gitignore` matches, binary
  files, and submodule contents. A directory outside git works too.
- `--limit` counts matching lines. The default is 2,000 and the maximum is
  20,000.
- Text output is `path:line:column: text`. Columns are 1-based UTF-16 offsets,
  and long lines are clipped around the match.
- `--json` prints `{ root, matchCount, truncated, files }`. Each file is
  `{ path, matches }`, and each match is `{ line, column, matchStart, text }`.
  `matchStart` is the match's offset inside the clipped `text`.
- `truncated` is `limit`, `bytes` (16 MiB buffered), `time` (60 seconds), or
  `null`. The command prints a notice on stderr when a text search stops early.
- No matches exits 0 with empty output. An invalid regex or a git failure exits
  non-zero with git's message.

## SDK

Call the RPCs with `bb.sdk.plugins.callRpc`, using plugin id `monaco-editor`
and a Zod `outputSchema` for each result.

- `searchStart` takes `{ query, mode, caseSensitive, limit?, file }`. It returns
  `{ kind: "started", searchId, root, hostId, environmentId }` or
  `{ kind: "unavailable", reason }`.
- `searchNext` takes `{ searchId }` and returns
  `{ status, files, matchCount, truncated, error }`.
- `searchCancel` takes `{ searchId }` and returns `null`.

`mode` is `literal` or `regex`. `file` selects the root and is
`{ path: ".", source: { kind: "workspace", threadId: null, environmentId, projectId: null } }`
for an environment. The server derives the root from it, and a host file
outside every workspace and project returns `unavailable`.

Call `searchNext` until `status` is not `running`. Each call waits briefly for
results and returns at most 1 MiB. A session expires 30 seconds after its last
pull and then reports `expired`. Each host keeps at most 3 live searches and
evicts the oldest. Call `searchCancel` to stop a search you no longer need.
