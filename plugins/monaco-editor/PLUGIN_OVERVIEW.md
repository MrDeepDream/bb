Edit a file in bb instead of only reading it. It applies to every place where bb opens a file: chat links, the file search, and `bb thread open`. The editor is Monaco, the editor from VS Code.

## What you get

- Tap the Save icon in the file bar to write your edits, including on mobile. Cmd+S, or Ctrl+S on Linux and Windows, also saves. If the file changed on disk since you opened it, a clean tab refreshes in place and a tab with unsaved edits offers Reload or Overwrite.
- Unsaved text survives tab switches, pane moves, and plugin reloads. Drafts are journaled in this browser and come back after a crash. Closing the last view of an unsaved file asks Save, Discard, or Cancel. The desktop app also asks before a window close, quit, reload, server switch, or update.
- Editor tabs with preview and pin, Close Others and Close All, and Split Right or Split Down with a second view of the same document.
- Find in file with Cmd+F or Ctrl+F, multiple cursors, block selection, bracket matching, and code folding.
- Find in Files with Cmd+Shift+F, or Ctrl+Shift+F on Linux and Windows, while the editor has focus. It searches saved files in the workspace or project, honors .gitignore, and jumps to the line and column. The `bb editor search` command runs the same search.
- Git gutter markers for added, changed, and removed lines against the last commit. They describe the saved file, move with your typing, and refresh after a save or a change on disk.
- JetBrains keys on Linux and Windows: Ctrl+D duplicates, Ctrl+Y deletes the line, Ctrl+W expands the selection, Alt+J adds the next match, Alt+Shift+Up or Down moves lines, and Ctrl+Shift+N or Ctrl+E opens file search with recent files.
- Back and forward through recent editor locations with Alt+Left and Alt+Right on Linux and Windows, or from the command palette.
- Breadcrumbs in the file bar that open the file tree at any folder of the active file.
- Syntax highlighting for about 86 common file types.
- A file tree that you toggle from the file bar. Filter by path, expand directories, and open another file. Right-click a row to copy its absolute path, relative path, or filename.
- Command palette actions for fold, unfold, sort selected lines, and copy the path of the current file.
- Colors that follow your bb theme, including light and dark switches and custom palettes.

## How it works

The plugin claims common code, configuration, and text extensions. Binary files such as images and PDFs stay with bb's own preview, and so do Markdown and HTML files, which bb renders with a Preview/Raw toggle. Files larger than 8 MB open in the read-only preview. Files outside the workspace and project sources open read-only.

To change the opener for one file type, go to Settings and open File openers. Right-click a file link for a one-off Open with choice.

There is no language server. Go-to-definition, find references, and type checking are not available.
