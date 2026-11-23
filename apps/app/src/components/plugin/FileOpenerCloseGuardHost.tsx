import { useEffect, useMemo } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { clearPanelTabPreviews } from "@/components/secondary-panel/panelTabChrome";
import {
  cancelPendingFileTabClose,
  discardPendingFileTabClose,
  getDirtyFileTabIds,
  savePendingFileTabClose,
  setFileOpenerCloseGuards,
  subscribeDirtyFileTabs,
  usePendingFileTabClose,
} from "@/lib/file-opener-close-guard";
import { usePluginSlotKind } from "@/lib/plugin-slots";

export function FileOpenerCloseGuardHost() {
  const fileOpeners = usePluginSlotKind("fileOpeners");
  const guards = useMemo(
    () => fileOpeners.flatMap((opener) => opener.experimental_closeGuard ?? []),
    [fileOpeners],
  );
  const pending = usePendingFileTabClose();

  useEffect(() => {
    setFileOpenerCloseGuards(guards);
  }, [guards]);

  useEffect(
    () =>
      subscribeDirtyFileTabs(() => clearPanelTabPreviews(getDirtyFileTabIds())),
    [],
  );

  const documentCount = pending?.documentCount ?? 0;
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) cancelPendingFileTabClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {documentCount === 1
              ? "Save changes to this file?"
              : `Save changes to ${documentCount} files?`}
          </DialogTitle>
          <DialogDescription>
            {pending?.error ??
              "Closing without saving discards the unsaved edits."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending?.isSaving === true}
            onClick={cancelPendingFileTabClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending?.isSaving === true}
            onClick={discardPendingFileTabClose}
          >
            Discard
          </Button>
          <Button
            type="button"
            disabled={pending?.isSaving === true}
            onClick={() => void savePendingFileTabClose()}
          >
            {pending?.isSaving === true ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
