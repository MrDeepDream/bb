import { Icon } from "@bb/shared-ui/icon";
import { COARSE_POINTER_TEXT_SM_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import type { ReactNode } from "react";
import { CONTEXT_SELECTION_SURFACE_CLASS } from "@bb/shared-ui/context-selection";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";

const TAB_PILL_DEFAULT_LABEL_MAX_WIDTH_CLASS = "max-w-[180px]";
const TAB_PILL_AFFORDANCE_BUTTON_BASE_CLASS =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted-foreground/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none max-md:pointer-coarse:size-5";
const TAB_PILL_AFFORDANCE_ICON_CLASS = "size-3.5 max-md:pointer-coarse:size-5";
const TAB_PILL_CLOSE_BUTTON_CLASS = `pointer-events-none absolute left-1.5 top-1/2 z-10 -translate-y-1/2 ${TAB_PILL_AFFORDANCE_BUTTON_BASE_CLASS} opacity-0 hover:opacity-100 group-hover/tab-pill:pointer-events-auto group-hover/tab-pill:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 disabled:opacity-30 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100`;
const TAB_PILL_LARGE_COARSE_POINTER_CLOSE_BUTTON_CLASS =
  "max-md:pointer-coarse:min-h-9 max-md:pointer-coarse:min-w-9";
const TAB_PILL_LEADING_VISUAL_CLASS =
  "inline-flex size-4 shrink-0 items-center justify-center [&_[data-icon-root]]:size-3.5 max-md:pointer-coarse:size-5 max-md:pointer-coarse:[&_[data-icon-root]]:size-5";

interface TabPillCloseAction {
  onClose: () => void;
  closeLabel: string;
  tooltip?: string;
}

interface TabPillEditorTab {
  id: string;
  panelId: string | undefined;
  isFocusable: boolean;
  isDirty: boolean;
  isPreview: boolean;
  onKeepOpen?: () => void;
}

interface TabPillProps {
  label: string;
  ariaLabel?: string;
  ariaKeyshortcuts?: string;
  iconOnly?: boolean;
  compact?: boolean;
  leadingVisual?: ReactNode;
  secondaryLabel?: string | null;
  title: string;
  isActive: boolean;
  onSelect: () => void;
  labelMaxWidthClass?: string;
  closeAction: TabPillCloseAction | null;
  enlargeCloseTargetOnCoarsePointer?: boolean;
  editorTab?: TabPillEditorTab;
}

export function TabPill({
  label,
  ariaLabel,
  ariaKeyshortcuts,
  iconOnly = false,
  compact = false,
  leadingVisual,
  secondaryLabel = null,
  title,
  isActive,
  onSelect,
  labelMaxWidthClass = TAB_PILL_DEFAULT_LABEL_MAX_WIDTH_CLASS,
  closeAction,
  enlargeCloseTargetOnCoarsePointer = false,
  editorTab,
}: TabPillProps) {
  const tabSemantics =
    editorTab === undefined
      ? { "aria-label": ariaLabel, "aria-pressed": isActive }
      : {
          id: editorTab.id,
          role: "tab" as const,
          "aria-controls": isActive ? editorTab.panelId : undefined,
          "aria-label": editorTab.isDirty
            ? `${ariaLabel ?? label}, unsaved changes`
            : ariaLabel,
          "aria-selected": isActive,
          tabIndex: editorTab.isFocusable ? 0 : -1,
          onDoubleClick: editorTab.onKeepOpen,
        };
  return (
    <div
      data-tab-pill=""
      role={editorTab === undefined ? undefined : "presentation"}
      onAuxClick={(event) => {
        if (event.button !== 1 || closeAction === null) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeAction.onClose();
      }}
      className={cn(
        `group/tab-pill relative inline-flex h-7 shrink-0 items-center rounded-md ${LIST_HOVER_TRANSITION} max-md:pointer-coarse:h-9`,
        COARSE_POINTER_TEXT_SM_CLASS,
        compact && "max-w-full",
        isActive
          ? cn(CONTEXT_SELECTION_SURFACE_CLASS, "text-foreground")
          : "text-muted-foreground hover:bg-state-hover",
        editorTab !== undefined &&
          (isActive
            ? "rounded-b-none font-medium after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-ring"
            : "rounded-none border-r border-border-seam font-normal"),
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-keyshortcuts={ariaKeyshortcuts}
        {...tabSemantics}
        className={cn(
          "flex h-full min-w-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          editorTab !== undefined
            ? cn("pl-3 focus-visible:ring-2", closeAction ? "pr-7.5" : "pr-3")
            : iconOnly
              ? "px-1.5"
              : "pl-1.5 pr-2",
          !iconOnly &&
            closeAction &&
            enlargeCloseTargetOnCoarsePointer &&
            "max-md:pointer-coarse:pl-3.5",
          compact &&
            (iconOnly
              ? "w-7 justify-center max-md:pointer-coarse:w-9"
              : "px-2"),
          compact && closeAction && !leadingVisual && "pl-8",
          compact &&
            closeAction &&
            enlargeCloseTargetOnCoarsePointer &&
            "max-md:pointer-coarse:pl-9",
        )}
      >
        {leadingVisual ? (
          <span
            className={cn(
              TAB_PILL_LEADING_VISUAL_CLASS,
              !iconOnly && (editorTab === undefined ? "mr-1.5" : "mr-2"),
              closeAction &&
                editorTab === undefined &&
                (compact
                  ? "group-hover/tab-pill:opacity-0 group-focus-within/tab-pill:opacity-0"
                  : "group-hover/tab-pill:opacity-0 tab-pill-close-focus-visible:opacity-0 [@media(hover:none)]:opacity-0"),
              compact &&
                closeAction &&
                (isActive
                  ? "[@media(hover:none)]:opacity-0"
                  : "[@media(hover:none)]:opacity-100"),
              compact &&
                closeAction &&
                enlargeCloseTargetOnCoarsePointer &&
                "max-md:pointer-coarse:absolute max-md:pointer-coarse:left-2",
            )}
          >
            {leadingVisual}
          </span>
        ) : null}
        <span
          className={cn(
            iconOnly ? "sr-only" : "truncate",
            !iconOnly && labelMaxWidthClass,
            editorTab?.isPreview && "italic",
          )}
          title={iconOnly ? undefined : title}
        >
          {label}
        </span>
        {secondaryLabel ? (
          <span className="ml-1 shrink-0 text-muted-foreground">
            {secondaryLabel}
          </span>
        ) : null}
      </button>
      {editorTab?.isDirty ? (
        <span
          aria-hidden
          data-tab-pill-dirty=""
          className="pointer-events-none absolute right-0.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center group-focus-within/tab-pill:opacity-0 group-hover/tab-pill:opacity-0 [@media(hover:none)]:hidden"
        >
          <span className="size-2 rounded-full bg-foreground" />
        </span>
      ) : null}
      {closeAction ? (
        <TabPillCloseButton
          closeAction={closeAction}
          compact={compact}
          editorMetrics={editorTab !== undefined}
          enlargeCloseTargetOnCoarsePointer={enlargeCloseTargetOnCoarsePointer}
          isActive={isActive}
        />
      ) : null}
    </div>
  );
}

function TabPillCloseButton({
  closeAction,
  compact,
  editorMetrics,
  enlargeCloseTargetOnCoarsePointer,
  isActive,
}: {
  closeAction: TabPillCloseAction;
  compact: boolean;
  editorMetrics: boolean;
  enlargeCloseTargetOnCoarsePointer: boolean;
  isActive: boolean;
}) {
  const button = (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onClick={closeAction.onClose}
      aria-label={closeAction.closeLabel}
      data-tab-pill-close
      className={cn(
        TAB_PILL_CLOSE_BUTTON_CLASS,
        editorMetrics &&
          "left-auto right-0.5 size-6 max-md:pointer-coarse:size-6 group-focus-within/tab-pill:pointer-events-auto group-focus-within/tab-pill:opacity-100",
        compact &&
          "left-2 top-auto z-auto translate-y-0 group-focus-within/tab-pill:pointer-events-auto group-focus-within/tab-pill:opacity-100",
        compact && !isActive && "[@media(hover:none)]:hidden",
        compact &&
          enlargeCloseTargetOnCoarsePointer &&
          "max-md:pointer-coarse:left-0",
        enlargeCloseTargetOnCoarsePointer &&
          TAB_PILL_LARGE_COARSE_POINTER_CLOSE_BUTTON_CLASS,
      )}
    >
      <Icon name="X" className={TAB_PILL_AFFORDANCE_ICON_CLASS} />
    </button>
  );
  return closeAction.tooltip === undefined ? (
    button
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{closeAction.tooltip}</TooltipContent>
    </Tooltip>
  );
}
