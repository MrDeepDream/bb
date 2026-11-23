const PANE_TEXT_INPUT_SELECTOR =
  '[role="tabpanel"] [role="textbox"][aria-multiline="true"]';
const MENU_SELECTOR = '[role="menu"]';
const PANE_TEXT_INPUT_WAIT_MS = 5000;
const PANE_TEXT_INPUT_SETTLE_MS = 500;

function isInMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(MENU_SELECTOR) !== null;
}

export function focusPaneTextInputWhenReady(pane: HTMLElement): () => void {
  const { ownerDocument } = pane;
  let isArmed = true;
  let focusedInput: HTMLElement | null = null;
  let settleTimeoutId: number | null = null;

  const isPaneTextInput = (target: EventTarget | null) =>
    target instanceof Element &&
    pane.contains(target) &&
    target.matches(PANE_TEXT_INPUT_SELECTOR);
  const clearSettle = () => {
    if (settleTimeoutId === null) return;
    window.clearTimeout(settleTimeoutId);
    settleTimeoutId = null;
  };
  const awaitSettle = () => {
    settleTimeoutId ??= window.setTimeout(stop, PANE_TEXT_INPUT_SETTLE_MS);
  };
  const stop = () => {
    if (!isArmed) return;
    isArmed = false;
    observer.disconnect();
    window.clearTimeout(deadlineId);
    clearSettle();
    ownerDocument.removeEventListener("focusin", onFocusIn, true);
    ownerDocument.removeEventListener("focusout", onFocusOut, true);
    ownerDocument.removeEventListener("keydown", onKeyDown, true);
    ownerDocument.removeEventListener("pointerdown", stop, true);
  };
  const reconcileFocus = () => {
    if (!isArmed) return;
    const active = ownerDocument.activeElement;
    if (isPaneTextInput(active)) {
      awaitSettle();
      return;
    }
    if (active !== null && active !== ownerDocument.body && !isInMenu(active)) {
      stop();
      return;
    }
    const input = pane.querySelector<HTMLElement>(PANE_TEXT_INPUT_SELECTOR);
    if (input === null || input === focusedInput) return;
    input.focus({ preventScroll: true });
    focusedInput = ownerDocument.activeElement === input ? input : null;
  };
  const onFocusIn = (event: FocusEvent) => {
    if (isPaneTextInput(event.target)) {
      awaitSettle();
    } else if (isInMenu(event.target)) {
      focusedInput = null;
      clearSettle();
    } else {
      stop();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.target !== ownerDocument.body &&
      !isInMenu(event.target) &&
      !isPaneTextInput(event.target)
    ) {
      stop();
    }
  };
  const onFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget === null && isInMenu(event.target)) {
      queueMicrotask(reconcileFocus);
    }
  };
  const removedFocusedInput = (records: readonly MutationRecord[]) =>
    focusedInput !== null &&
    ownerDocument.activeElement !== focusedInput &&
    records.some((record) =>
      Array.from(record.removedNodes).some((node) =>
        node.contains(focusedInput),
      ),
    );
  const observer = new MutationObserver((records) => {
    if (removedFocusedInput(records)) {
      focusedInput = null;
      clearSettle();
    }
    reconcileFocus();
  });
  const deadlineId = window.setTimeout(stop, PANE_TEXT_INPUT_WAIT_MS);
  observer.observe(pane, { childList: true, subtree: true });
  ownerDocument.addEventListener("focusin", onFocusIn, true);
  ownerDocument.addEventListener("focusout", onFocusOut, true);
  ownerDocument.addEventListener("keydown", onKeyDown, true);
  ownerDocument.addEventListener("pointerdown", stop, true);
  reconcileFocus();
  return stop;
}
