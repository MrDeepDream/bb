import {
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type ProjectSource,
} from "@bb/domain";
import type {
  ProjectDirectoryResponse,
  SidebarBootstrapResponse,
} from "@bb/server-contract";
import { Icon } from "@bb/shared-ui/icon";
import { resolveAbsoluteFilePath } from "@bb/shared-ui/lib/absolute-file-path";
import { isNonImeKey } from "@bb/shared-ui/lib/ime-keyboard";
import { cn } from "@bb/shared-ui/lib/utils";
import { appToast } from "@/components/ui/app-toast";
import { projectDirectoryQueryKey } from "@/hooks/queries/query-keys";
import { sidebarNavigationThreadSelectionQueryOptions } from "@/hooks/queries/sidebar-navigation-query";
import { useCompilerSafeVirtualizer } from "@/hooks/useCompilerSafeVirtualizer";
import { usePathPickerHost } from "@/hooks/useLocalPathPicker";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { getFocusedAppNavigationSurface } from "@/lib/app-navigation-host";
import { BbHttpError, sdk } from "@/lib/sdk";
import {
  flattenProjectTreeRows,
  listVisibleOpenFolders,
  projectFileGlyph,
  projectTreeKey,
  type ProjectFileGlyph,
  type ProjectTreeListing,
  type ProjectTreeRoot,
  type ProjectTreeRow,
} from "./project-tree-rows";

const ROW_HEIGHT_PX = 24;
const ROW_OVERSCAN = 8;
const ROW_BASE_INDENT_PX = 6;
const ROW_LEVEL_INDENT_PX = 12;
const HEADER_CONTROL_CLASS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors duration-100 ease-out hover:bg-state-hover active:bg-state-active focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const GLYPH_TONE_CLASS: Record<
  Extract<ProjectFileGlyph, { kind: "icon" }>["icon"],
  string
> = {
  Asterisk: "text-warning-text",
  FileText: "text-muted-foreground",
  GitBranch: "text-warning-text",
  Info: "text-file-accent",
};

interface ProjectRootSummary {
  id: string;
  name: string;
  sources: ProjectSource[];
}

function selectProjectRoots(
  navigation: SidebarBootstrapResponse,
): ProjectRootSummary[] {
  return navigation.projects.flatMap((project) =>
    project.id === PERSONAL_PROJECT_ID
      ? []
      : [{ id: project.id, name: project.name, sources: project.sources }],
  );
}

const projectRootsQueryOptions =
  sidebarNavigationThreadSelectionQueryOptions(selectProjectRoots);

function listingErrorLabel(error: unknown): string {
  if (!(error instanceof BbHttpError)) return "Cannot read";
  switch (error.code) {
    case "ENOENT":
      return "Not found";
    case "EACCES":
    case "EPERM":
      return "No access";
    case "host_unavailable":
      return "Host unavailable";
    default:
      return "Cannot read";
  }
}

function combineProjectListings(
  results: UseQueryResult<ProjectDirectoryResponse, Error>[],
): ProjectTreeListing[] {
  return results.map<ProjectTreeListing>((result) => {
    if (result.isError) {
      return { status: "error", label: listingErrorLabel(result.error) };
    }
    if (result.data === undefined) return { status: "loading" };
    return {
      status: "ready",
      entries: result.data.entries,
      truncated: result.data.truncated,
    };
  });
}

function ProjectFileBadge({
  badge,
}: {
  badge: Extract<ProjectFileGlyph, { kind: "badge" }>["badge"];
}) {
  if (badge === "json") {
    return (
      <svg viewBox="0 0 14 14" aria-hidden="true" className="size-3.5 shrink-0">
        <text
          x="7"
          y="10.5"
          textAnchor="middle"
          fontSize="10"
          fontWeight="700"
          fill="var(--warning-text)"
        >
          {"{}"}
        </text>
      </svg>
    );
  }
  const badgeStyle = {
    javascript: {
      background: "var(--attention)",
      foreground: "var(--attention-foreground)",
      fontSize: "6.5",
      label: "JS",
      radius: "3",
    },
    markdown: {
      background: "var(--file-accent)",
      foreground: "var(--background)",
      fontSize: "6.5",
      label: "M↓",
      radius: "3",
    },
    pen: {
      background: "var(--pr-merged)",
      foreground: "var(--background)",
      fontSize: "8",
      label: "P",
      radius: "3",
    },
    unreal: {
      background: "var(--foreground)",
      foreground: "var(--background)",
      fontSize: "8",
      label: "U",
      radius: "7",
    },
  }[badge];
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" className="size-3.5 shrink-0">
      <rect
        width="14"
        height="14"
        rx={badgeStyle.radius}
        fill={badgeStyle.background}
      />
      <text
        x="7"
        y="7"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize={badgeStyle.fontSize}
        fontWeight="800"
        fill={badgeStyle.foreground}
      >
        {badgeStyle.label}
      </text>
    </svg>
  );
}

function ProjectTreeGlyph({ row }: { row: ProjectTreeRow }) {
  if (row.kind === "project") {
    return (
      <Icon
        name="SquareDashedBottomCode"
        aria-hidden
        className="size-3.5 shrink-0 text-file-accent"
      />
    );
  }
  if (row.kind === "directory") {
    return (
      <Icon
        name={row.expanded ? "FolderOpen" : "Folder"}
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    );
  }
  const glyph = projectFileGlyph(row.name);
  if (glyph.kind === "badge") return <ProjectFileBadge badge={glyph.badge} />;
  return (
    <Icon
      name={glyph.icon}
      aria-hidden
      className={cn("size-3.5 shrink-0", GLYPH_TONE_CLASS[glyph.icon])}
    />
  );
}

export function ProjectsRegion() {
  const quickCreateProject = useQuickCreateProjectController();
  const { hostId } = usePathPickerHost();
  const { data: projects } = useQuery(projectRootsQueryOptions);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const treeId = useId();
  const labelId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);

  const roots = useMemo<ProjectTreeRoot[]>(
    () =>
      (projects ?? []).map((project) => ({
        projectId: project.id,
        name: project.name,
        rootPath:
          hostId === null
            ? null
            : (findLocalPathProjectSourceForHost(project.sources, hostId)
                ?.path ?? null),
        unavailableLabel:
          hostId === null ? "Host unavailable" : "Not on this host",
      })),
    [hostId, projects],
  );
  const openFolders = useMemo(
    () => listVisibleOpenFolders(roots, openKeys),
    [openKeys, roots],
  );
  const listingStates = useQueries({
    combine: combineProjectListings,
    queries:
      hostId === null
        ? []
        : openFolders.map((folder) => ({
            queryKey: projectDirectoryQueryKey(
              folder.projectId,
              hostId,
              folder.relativePath,
            ),
            queryFn: ({ signal }: { signal: AbortSignal }) =>
              sdk.projects.directory({
                projectId: folder.projectId,
                hostId,
                ...(folder.relativePath === ""
                  ? {}
                  : { path: folder.relativePath }),
                signal,
              }),
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            retry: false,
          })),
  });
  const listings = useMemo(() => {
    const listingsByKey = new Map<string, ProjectTreeListing>();
    openFolders.forEach((folder, index) => {
      const listing = listingStates[index];
      if (listing !== undefined) listingsByKey.set(folder.key, listing);
    });
    return listingsByKey;
  }, [listingStates, openFolders]);
  const rows = useMemo(
    () => flattenProjectTreeRows(roots, listings, openKeys),
    [listings, openKeys, roots],
  );
  const foundActiveIndex =
    activeKey === null ? -1 : rows.findIndex((row) => row.key === activeKey);
  const activeIndex = rows.length === 0 ? -1 : Math.max(foundActiveIndex, 0);

  const getScrollElement = useCallback(() => scrollRef.current, []);
  const estimateRowSize = useCallback(() => ROW_HEIGHT_PX, []);
  const getRowKey = useCallback(
    (index: number) => rows[index]?.key ?? index,
    [rows],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeIndex < 0 || indexes.includes(activeIndex)) return indexes;
      return activeIndex < (indexes[0] ?? 0)
        ? [activeIndex, ...indexes]
        : [...indexes, activeIndex];
    },
    [activeIndex],
  );
  const { virtualItems, totalSize, scrollToIndex } = useCompilerSafeVirtualizer(
    {
      count: rows.length,
      getScrollElement,
      estimateSize: estimateRowSize,
      getItemKey: getRowKey,
      overscan: ROW_OVERSCAN,
      rangeExtractor,
    },
  );
  const isActiveRowMounted = virtualItems.some(
    (item) => item.index === activeIndex,
  );

  const setFolderOpen = (key: string, open: boolean) => {
    setOpenKeys((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const openFile = (row: ProjectTreeRow) => {
    const rootPath =
      roots.find((root) => root.projectId === row.projectId)?.rootPath ?? null;
    const path = resolveAbsoluteFilePath({ path: row.relativePath, rootPath });
    const opened =
      hostId !== null &&
      path !== null &&
      (getFocusedAppNavigationSurface()?.openFilePreview({
        target: { kind: "host", hostId, path },
        location: null,
      }) ??
        false);
    if (!opened) {
      appToast.error("Can't preview this file here", {
        description: "Open a chat on this machine, then try again.",
      });
    }
  };

  const activateRow = (row: ProjectTreeRow) => {
    if (row.expandable) {
      setFolderOpen(row.key, !row.expanded);
    } else if (row.kind === "file") {
      openFile(row);
    }
  };

  const moveActive = (index: number) => {
    const next = rows[index];
    if (next === undefined) return;
    setActiveKey(next.key);
    scrollToIndex(index, { align: "auto" });
  };

  const collapseAll = () => {
    const activeRow = rows[activeIndex];
    setOpenKeys(new Set());
    if (activeRow !== undefined) {
      setActiveKey(projectTreeKey(activeRow.projectId, ""));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const row = rows[activeIndex];
    if (row === undefined) return;
    if (isNonImeKey(event, "Enter") || isNonImeKey(event, " ")) {
      event.preventDefault();
      if (!event.repeat) activateRow(row);
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        moveActive(Math.min(activeIndex + 1, rows.length - 1));
        break;
      case "ArrowUp":
        moveActive(Math.max(activeIndex - 1, 0));
        break;
      case "Home":
        moveActive(0);
        break;
      case "End":
        moveActive(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.expandable) setFolderOpen(row.key, true);
        break;
      case "ArrowLeft":
        if (row.expandable) setFolderOpen(row.key, false);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <section
      aria-labelledby={labelId}
      data-testid="app-sidebar-projects"
      className="flex min-h-0 flex-1 flex-col border-t border-border-seam"
    >
      <div className="flex h-[38px] shrink-0 items-center pl-4 pr-2">
        <span
          id={labelId}
          className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground"
        >
          Projects
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <span
            aria-hidden="true"
            className="inline-flex size-6 items-center justify-center text-muted-foreground"
          >
            <Icon name="Search" aria-hidden className="size-3.5" />
          </span>
          <button
            type="button"
            aria-label="Add project"
            disabled={!quickCreateProject.isAvailable}
            className={HEADER_CONTROL_CLASS}
            onClick={() => quickCreateProject.openCreateDialog()}
          >
            <Icon name="FolderPlus" aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Collapse all"
            className={HEADER_CONTROL_CLASS}
            onClick={collapseAll}
          >
            <Icon name="ChevronsDownUp" aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>
      {projects !== undefined && rows.length === 0 ? (
        <div className="flex h-6 shrink-0 items-center truncate px-4 text-xs text-muted-foreground">
          No project folders
        </div>
      ) : (
        <div
          ref={scrollRef}
          role="tree"
          aria-labelledby={labelId}
          aria-activedescendant={
            isActiveRowMounted ? `${treeId}-${activeIndex}` : undefined
          }
          tabIndex={0}
          className="group/tree relative min-h-0 flex-1 overflow-y-auto outline-none"
          onKeyDown={handleKeyDown}
        >
          <div
            role="presentation"
            className="relative w-full"
            style={{ height: totalSize }}
          >
            {virtualItems.map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              return (
                <div
                  key={row.key}
                  id={`${treeId}-${item.index}`}
                  role="treeitem"
                  aria-level={row.level + 1}
                  aria-posinset={row.posInSet}
                  aria-setsize={row.setSize}
                  aria-expanded={row.expandable ? row.expanded : undefined}
                  data-active={item.index === activeIndex ? "" : undefined}
                  className="absolute inset-x-2 top-0 flex h-6 cursor-default select-none items-center gap-1.5 rounded-[5px] pr-2 text-sm text-sidebar-foreground data-active:group-focus-visible/tree:outline-2 data-active:group-focus-visible/tree:-outline-offset-2 data-active:group-focus-visible/tree:outline-ring"
                  style={{
                    paddingLeft:
                      ROW_BASE_INDENT_PX + row.level * ROW_LEVEL_INDENT_PX,
                    transform: `translateY(${item.start}px)`,
                  }}
                  onClick={() => {
                    setActiveKey(row.key);
                    activateRow(row);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-3 shrink-0 items-center justify-center text-subtle-foreground"
                  >
                    {row.expandable ? (
                      <Icon
                        name={row.expanded ? "ChevronDown" : "ChevronRight"}
                        aria-hidden
                        className="size-3"
                      />
                    ) : null}
                  </span>
                  <ProjectTreeGlyph row={row} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      row.level === 0 && "font-medium",
                      row.dim && "text-muted-foreground",
                    )}
                  >
                    {row.name}
                  </span>
                  {row.meta === null ? null : (
                    <span className="shrink-0 text-2xs text-subtle-foreground">
                      {row.meta}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
