# bb-plugin-monaco-editor

Opens files in BB using [Monaco](https://microsoft.github.io/monaco-editor/),
the editor from VS Code, instead of BB's read-only file preview.

It applies everywhere BB opens a file: links clicked in chat, the secondary
panel's file search, and `bb thread open`.

## Features

- **Edit and save.** Tap the **Save** icon in the file bar, or press <kbd>⌘S</kbd>
  (<kbd>Ctrl+S</kbd> on Linux and Windows), to write the file. Edits stay
  unsaved until you save. If it changed on disk
  since you opened it — often because the agent edited it — a clean tab
  refreshes in place and keeps your cursor. A tab with unsaved edits offers
  **Reload** or **Overwrite**, and a save never replaces a newer file silently.
  After **Reload**, **Undo** restores your discarded draft without writing to
  disk. The conflict choices return so saving the draft still requires an
  explicit decision. Undo stays available until you edit, save, or reload again.
- **Unsaved text is protected.** It survives tab switches, moving a tab between
  panes, and plugin reloads. Drafts are also journaled to this browser's
  IndexedDB and come back when you reopen the file, including after a crash.
  Closing the last view of an unsaved file asks **Save**, **Discard**, or
  **Cancel**. In the desktop app, closing the window, quitting, reloading,
  switching server, or installing an update asks **Keep editing** or
  **Close, keep drafts**.
- **Tabs and splits.** A file opens in a preview tab that the next file reuses;
  editing or pinning it keeps it. **Split Right** and **Split Down** open a
  second view of the same document, sharing its text and undo history. The tab
  menu also has **Close Others** and **Close All**.
- **Write boundary.** Files inside the workspace or a project source are
  editable. Other files on the host open read-only.
- **Find in file** with <kbd>⌘F</kbd>, plus Monaco's usual editing: multiple
  cursors, block selection, bracket matching, code folding.
- **Find in files** with <kbd>⌘⇧F</kbd> (<kbd>Ctrl+Shift+F</kbd> on Linux and
  Windows) while the editor has focus, or _Monaco: find in files_ in the quick
  palette. It searches the saved files of the active file's workspace or
  project with `git grep`, honors `.gitignore`, and lists results by file as
  they arrive. Enter or click jumps to the line and column, and
  <kbd>Alt+←</kbd> returns. Literal or regex, optional case matching, Cancel,
  and a notice when a limit stops the search. A host file outside every
  workspace and project has no search root. `bb editor search` and the
  `searchStart`, `searchNext`, and `searchCancel` RPCs run the same search; see
  `skills/monaco-editor/SKILL.md`.
- **Git gutter markers.** Files in a Git workspace or project show added,
  changed, and removed lines against `HEAD` in the gutter: a solid bar, a
  dashed bar, and a small wedge at the boundary of a removal. An untracked file
  is all added. Markers describe the saved file. While you type they move with
  the text, and they refresh after a save, a change on disk, a ref change in
  the workspace, or when the window regains focus. Files outside a repository,
  a repository with no commits, a project root inside a repository
  subdirectory, and patches over 512 KiB show no markers. A patch is shown only
  when its own header names the file. Only files visible in a pane are read,
  through the Git plugin's `patchesByPath` RPC with up to 50 paths per call.
  `bb git patch` prints the same data.
- **JetBrains keys on Linux and Windows.** <kbd>Ctrl+D</kbd> duplicates,
  <kbd>Ctrl+Y</kbd> deletes the line, <kbd>Ctrl+W</kbd> expands the selection,
  <kbd>Alt+J</kbd> adds the next match, and <kbd>Alt+Shift+↑/↓</kbd> move lines.
  <kbd>Ctrl+Shift+N</kbd> and <kbd>Ctrl+E</kbd> open file search with recent
  files. macOS keeps Monaco's defaults.
- **Back and forward.** <kbd>Alt+←/→</kbd> on Linux and Windows, or _Monaco: go
  back / go forward_ in the quick palette, walk recent editor locations across
  files and reopen a closed file.
- **Breadcrumbs.** The file bar shows the active file's folders; each opens the
  file tree. _Monaco: focus breadcrumbs_ reaches them from the keyboard.
- **Syntax highlighting** for ~86 common file types.
- **File tree.** Toggle it from the file bar to browse the project, filter by
  path, expand and collapse directories, and jump to another file. It opens
  with the current file revealed. Right-click any row to copy its absolute
  path, relative path, or filename.
- **Quick palette commands.** Open the quick palette (<kbd>⌘⇧P</kbd>) and
  type "fold", "sort", or "copy" to reach *fold level 1–5*, *fold
  recursively*, *unfold all*, *unfold recursively*, *unfold at cursor*,
  *sort selected lines ascending/descending*, and *copy the path / relative
  path of the current file*. The sort rows appear only with a multi-line
  selection, and every row acts on the Monaco tab you last worked in.
- **Follows your theme,** including light/dark switches and custom palettes.

## Development

Ships with BB as a builtin; there is nothing to install.

```
pnpm exec turbo run typecheck test --filter=bb-plugin-monaco-editor
```

`scripts/stage-assets.mjs` builds the Monaco bundle the editor loads, into
`dist/monaco`. Packaging runs it (`bb-plugin-build prepare-bundled`),
since only a builtin's `dist/` ships. A source checkout never runs that path —
the dev server loads builtins straight from `plugins/<name>` — so the plugin
builds the bundle itself when it is missing or older than `monaco-bundle/`,
which makes that one file open a few seconds slow.
`pnpm --filter bb-plugin-monaco-editor build:monaco` does it up front.

The dev loop already rebuilds `dist/app.js` and reloads `server.ts` on save,
so editing `app.tsx`, `components/`, `lib/`, or `server.ts` needs nothing
extra. It knows nothing about the Monaco bundle, which is why the staleness
check exists: edit `monaco-bundle/` and the next file open rebuilds.

Monaco is built rather than bundled into `app.js` because `bb plugin build`
emits one file with no code splitting: Monaco would parse at app boot for
everyone, including users who never open a file, and its worker could not be
emitted at all. `lib/monaco-loader.ts` loads the built files from a
`files.createPreview` URL the first time a file tab opens.

`monaco-bundle/editor.js` is the entry: Monaco's own `editor.main`, which is
the API plus its contribution modules (find, folding, word navigation,
sorting, …) and every Monarch grammar. What it leaves out is the language
*services* for CSS, HTML, JSON, and TypeScript — completion and type checking
this plugin has no use for. esbuild proves what is reachable, so the result is
4.6 MB rather than the 24 MB of Monaco's prebuilt tree. Monaco's icon webfont
is inlined as a data URL, so the bundle stays the three files the loader
fetches from the preview URL: `editor.js`, `editor.css`, and
`editor.worker.js`.

Do not trim that entry to `editor.api` to save the difference. The API without
the contributions still opens files and still types, so the editor looks fine
while find, word navigation, and folding silently do not exist. The build
script asserts each of those is present for that reason.

## Which files it opens

The plugin claims the extensions listed in `lib/languages.ts` — common code,
config, and text formats. Binaries like `png` and `pdf` are left to BB's own
preview, which renders them properly. So are Markdown (`md`, `markdown`) and
HTML (`html`, `htm`) files: they open in BB's rendered preview with its
Preview/Raw toggle. Monaco still highlights them when opened from its file tree.

To change any file type back, use **Settings → File openers**, which offers
Automatic, BB's built-in preview, or Monaco per extension. Right-clicking a
file link also offers a one-off "Open with…".

## Roadmap

- **Language intelligence.** There is no language server, so no
  go-to-definition, find-references, or type checking. Monaco ships a
  TypeScript checker, but it can only see the one open file, so every import
  looks unresolved — it is switched off rather than showing errors that are
  wrong.
- **File operations.** The tree is read-only; renaming, creating, and
  deleting files are not implemented yet.
- **Hidden files and `node_modules`** never appear in the tree. BB's path
  listing excludes them and offers no way to ask for them
  ([#2093](https://github.com/get-bb/bb/issues/2093)).
- **No "open in editor" button** like BB's preview has; that capability is not
  available to plugins.
- **Thread-storage files on a remote machine** fail to open.
