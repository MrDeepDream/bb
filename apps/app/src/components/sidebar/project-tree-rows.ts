export interface ProjectTreeRoot {
  projectId: string;
  name: string;
  rootPath: string | null;
  unavailableLabel: string;
}

export interface ProjectTreeEntry {
  kind: "directory" | "file";
  name: string;
  path: string;
}

export type ProjectTreeListing =
  | { status: "loading" }
  | { status: "error"; label: string }
  | {
      status: "ready";
      entries: readonly ProjectTreeEntry[];
      truncated: boolean;
    };

export interface ProjectTreeFolder {
  key: string;
  projectId: string;
  relativePath: string;
}

export interface ProjectTreeRow {
  key: string;
  projectId: string;
  relativePath: string;
  name: string;
  kind: "project" | "directory" | "file";
  level: number;
  expandable: boolean;
  expanded: boolean;
  dim: boolean;
  meta: string | null;
  posInSet: number;
  setSize: number;
}

export type ProjectFileGlyph =
  | { kind: "icon"; icon: "Asterisk" | "FileText" | "GitBranch" | "Info" }
  | {
      kind: "badge";
      badge: "javascript" | "json" | "markdown" | "pen" | "unreal";
    };

const KEY_SEPARATOR = "\0";

const FILE_NAME_GLYPHS: ReadonlyMap<string, ProjectFileGlyph> = new Map([
  ["claude.md", { kind: "icon", icon: "Asterisk" }],
  ["readme.md", { kind: "icon", icon: "Info" }],
  [".gitignore", { kind: "icon", icon: "GitBranch" }],
  [".gitattributes", { kind: "icon", icon: "GitBranch" }],
]);

const FILE_EXTENSION_GLYPHS: ReadonlyMap<string, ProjectFileGlyph> = new Map([
  ["md", { kind: "badge", badge: "markdown" }],
  ["js", { kind: "badge", badge: "javascript" }],
  ["mjs", { kind: "badge", badge: "javascript" }],
  ["pen", { kind: "badge", badge: "pen" }],
  ["uproject", { kind: "badge", badge: "unreal" }],
  ["json", { kind: "badge", badge: "json" }],
]);

const DEFAULT_FILE_GLYPH: ProjectFileGlyph = { kind: "icon", icon: "FileText" };

export function projectFileGlyph(name: string): ProjectFileGlyph {
  const lowerName = name.toLowerCase();
  const named = FILE_NAME_GLYPHS.get(lowerName);
  if (named !== undefined) return named;
  const dotIndex = lowerName.lastIndexOf(".");
  if (dotIndex === -1) return DEFAULT_FILE_GLYPH;
  return (
    FILE_EXTENSION_GLYPHS.get(lowerName.slice(dotIndex + 1)) ??
    DEFAULT_FILE_GLYPH
  );
}

export function projectTreeKey(
  projectId: string,
  relativePath: string,
): string {
  return `${projectId}${KEY_SEPARATOR}${relativePath}`;
}

function hasOpenAncestors(
  projectId: string,
  relativePath: string,
  openKeys: ReadonlySet<string>,
): boolean {
  let end = relativePath.lastIndexOf("/");
  while (end !== -1) {
    const ancestor = relativePath.slice(0, end);
    if (!openKeys.has(projectTreeKey(projectId, ancestor))) return false;
    end = ancestor.lastIndexOf("/");
  }
  return relativePath === "" || openKeys.has(projectTreeKey(projectId, ""));
}

export function listVisibleOpenFolders(
  roots: readonly ProjectTreeRoot[],
  openKeys: ReadonlySet<string>,
): ProjectTreeFolder[] {
  const listableProjectIds = new Set(
    roots.flatMap((root) => (root.rootPath === null ? [] : [root.projectId])),
  );
  const folders: ProjectTreeFolder[] = [];
  for (const key of openKeys) {
    const separator = key.indexOf(KEY_SEPARATOR);
    const projectId = key.slice(0, separator);
    const relativePath = key.slice(separator + 1);
    if (
      listableProjectIds.has(projectId) &&
      hasOpenAncestors(projectId, relativePath, openKeys)
    ) {
      folders.push({ key, projectId, relativePath });
    }
  }
  return folders;
}

function listingMeta(listing: ProjectTreeListing | undefined): string | null {
  if (listing === undefined || listing.status === "loading") return "Loading…";
  if (listing.status === "error") return listing.label;
  return listing.truncated ? "Truncated" : null;
}

function appendChildren(
  rows: ProjectTreeRow[],
  projectId: string,
  parentKey: string,
  level: number,
  listings: ReadonlyMap<string, ProjectTreeListing>,
  openKeys: ReadonlySet<string>,
): void {
  const listing = listings.get(parentKey);
  if (listing?.status !== "ready") return;
  const setSize = listing.entries.length;
  listing.entries.forEach((entry, index) => {
    const key = projectTreeKey(projectId, entry.path);
    const isDirectory = entry.kind === "directory";
    const expanded = isDirectory && openKeys.has(key);
    rows.push({
      key,
      projectId,
      relativePath: entry.path,
      name: entry.name,
      kind: entry.kind,
      level,
      expandable: isDirectory,
      expanded,
      dim: !isDirectory && entry.name.startsWith("."),
      meta: expanded ? listingMeta(listings.get(key)) : null,
      posInSet: index + 1,
      setSize,
    });
    if (expanded) {
      appendChildren(rows, projectId, key, level + 1, listings, openKeys);
    }
  });
}

export function flattenProjectTreeRows(
  roots: readonly ProjectTreeRoot[],
  listings: ReadonlyMap<string, ProjectTreeListing>,
  openKeys: ReadonlySet<string>,
): ProjectTreeRow[] {
  const rows: ProjectTreeRow[] = [];
  roots.forEach((root, index) => {
    const key = projectTreeKey(root.projectId, "");
    const expandable = root.rootPath !== null;
    const expanded = expandable && openKeys.has(key);
    rows.push({
      key,
      projectId: root.projectId,
      relativePath: "",
      name: root.name,
      kind: "project",
      level: 0,
      expandable,
      expanded,
      dim: false,
      meta: !expandable
        ? root.unavailableLabel
        : expanded
          ? listingMeta(listings.get(key))
          : null,
      posInSet: index + 1,
      setSize: roots.length,
    });
    if (expanded) {
      appendChildren(rows, root.projectId, key, 1, listings, openKeys);
    }
  });
  return rows;
}
