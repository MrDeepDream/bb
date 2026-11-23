import type { WebContents } from "electron";

interface AltTapInput {
  alt: boolean;
  control: boolean;
  isAutoRepeat: boolean;
  isComposing: boolean;
  key: string;
  meta: boolean;
  shift: boolean;
  type: string;
}

function isBareAltInput(input: AltTapInput): boolean {
  return (
    input.key === "Alt" &&
    !input.control &&
    !input.meta &&
    !input.shift &&
    !input.isAutoRepeat &&
    !input.isComposing
  );
}

export function createAltTapDetector() {
  let armed = false;
  return {
    disarm(): void {
      armed = false;
    },
    isArmed(): boolean {
      return armed;
    },
    handleInput(input: AltTapInput): boolean {
      const wasArmed = armed;
      armed = false;
      if (!isBareAltInput(input)) return false;
      if (input.type === "keyDown" || input.type === "rawKeyDown") {
        armed = !wasArmed;
        return false;
      }
      return input.type === "keyUp" && wasArmed;
    },
  };
}

export function watchApplicationMenuAltTap(
  webContents: WebContents,
  onTap: () => void,
): void {
  if (process.platform !== "win32") return;
  const detector = createAltTapDetector();
  let watchingMouse = false;
  const syncMouseWatch = () => {
    const armed = detector.isArmed();
    if (armed === watchingMouse) return;
    watchingMouse = armed;
    if (armed) webContents.on("before-mouse-event", disarmOnMouse);
    else webContents.off("before-mouse-event", disarmOnMouse);
  };
  const disarm = () => {
    detector.disarm();
    syncMouseWatch();
  };
  const disarmOnMouse = (_event: unknown, mouse: { type: string }) => {
    if (mouse.type === "mouseDown") disarm();
  };
  webContents.on("before-input-event", (_event, input) => {
    const tapped = detector.handleInput(input);
    syncMouseWatch();
    if (tapped) onTap();
  });
  webContents.on("blur", disarm);
}
