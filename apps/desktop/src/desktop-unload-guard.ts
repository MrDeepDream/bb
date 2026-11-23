export type DesktopUnloadRoute =
  | "window"
  | "quit"
  | "reload"
  | "server"
  | "update";

export interface DesktopUnloadWindow {
  readonly webContents: { readonly id: number };
  isDestroyed(): boolean;
  close(): void;
}

export interface DesktopUnloadPrompt<Window extends DesktopUnloadWindow> {
  route: DesktopUnloadRoute;
  window: Window | null;
}

export interface DesktopUnloadGuard<Window extends DesktopUnloadWindow> {
  setDirty(webContentsId: number, hasDirty: boolean): void;
  forget(webContentsId: number): void;
  hasDirtyWindow(webContentsId: number): boolean;
  approveAll(): void;
  clearApproval(): void;
  blockWindowClose(event: { preventDefault(): void }, window: Window): boolean;
  blockQuit(event: { preventDefault(): void }, resumeQuit: () => void): boolean;
  confirmWindowUnload(
    route: DesktopUnloadRoute,
    window: Window,
  ): Promise<boolean>;
  confirmAppUnload(
    route: DesktopUnloadRoute,
    window: Window | null,
  ): Promise<boolean>;
  hasDirty(): boolean;
  runApprovedUnload(
    route: DesktopUnloadRoute,
    window: Window | null,
    action: () => Promise<void>,
  ): Promise<boolean>;
  navigate(load: () => Promise<void>): Promise<void>;
  runWhenClean(key: string, task: () => void | Promise<void>): void;
}

const HELD_NAVIGATION_KEY = "navigation";

export function createDesktopUnloadGuard<Window extends DesktopUnloadWindow>({
  prompt,
  logError,
}: {
  prompt: (request: DesktopUnloadPrompt<Window>) => Promise<boolean>;
  logError: (error: unknown) => void;
}): DesktopUnloadGuard<Window> {
  const dirtyWebContents = new Set<number>();
  const approvedWindows = new Set<number>();
  const openPrompts = new Map<string, Promise<boolean>>();
  const heldTasks = new Map<string, () => void | Promise<void>>();
  let approvedAll = false;
  let approvedScopes = 0;

  function mayUnload(): boolean {
    return approvedAll || approvedScopes > 0 || dirtyWebContents.size === 0;
  }

  function runHeldTasks(): void {
    if (approvedAll || dirtyWebContents.size > 0) return;
    const tasks = [...heldTasks.values()];
    heldTasks.clear();
    for (const task of tasks) {
      void Promise.resolve().then(task).catch(logError);
    }
  }

  async function confirmAppUnload(
    route: DesktopUnloadRoute,
    window: Window | null,
  ): Promise<boolean> {
    if (mayUnload()) return true;
    return ask("app", { route, window });
  }

  function ask(
    key: string,
    request: DesktopUnloadPrompt<Window>,
  ): Promise<boolean> {
    const open = openPrompts.get(key);
    if (open !== undefined) return open;
    const asked = prompt(request)
      .catch(() => false)
      .finally(() => openPrompts.delete(key));
    openPrompts.set(key, asked);
    return asked;
  }

  return {
    setDirty(webContentsId, hasDirty) {
      if (hasDirty) {
        dirtyWebContents.add(webContentsId);
      } else {
        dirtyWebContents.delete(webContentsId);
        approvedWindows.delete(webContentsId);
        runHeldTasks();
      }
    },
    forget(webContentsId) {
      dirtyWebContents.delete(webContentsId);
      approvedWindows.delete(webContentsId);
      runHeldTasks();
    },
    hasDirtyWindow(webContentsId) {
      return dirtyWebContents.has(webContentsId);
    },
    approveAll() {
      approvedAll = true;
    },
    clearApproval() {
      approvedAll = false;
      approvedWindows.clear();
      runHeldTasks();
    },
    blockWindowClose(event, window) {
      const webContentsId = window.webContents.id;
      if (
        approvedAll ||
        approvedWindows.has(webContentsId) ||
        !dirtyWebContents.has(webContentsId)
      ) {
        return false;
      }
      event.preventDefault();
      void ask(`window:${webContentsId}`, { route: "window", window }).then(
        (approved) => {
          if (!approved || window.isDestroyed()) return;
          approvedWindows.add(webContentsId);
          window.close();
        },
      );
      return true;
    },
    blockQuit(event, resumeQuit) {
      if (approvedAll || dirtyWebContents.size === 0) return false;
      event.preventDefault();
      void ask("app", { route: "quit", window: null }).then((approved) => {
        if (!approved) return;
        approvedAll = true;
        resumeQuit();
      });
      return true;
    },
    async confirmWindowUnload(route, window) {
      const webContentsId = window.webContents.id;
      if (
        approvedAll ||
        approvedScopes > 0 ||
        !dirtyWebContents.has(webContentsId)
      ) {
        return true;
      }
      return ask(`window:${webContentsId}`, { route, window });
    },
    confirmAppUnload,
    hasDirty() {
      return dirtyWebContents.size > 0;
    },
    async runApprovedUnload(route, window, action) {
      if (!(await confirmAppUnload(route, window))) return false;
      approvedScopes += 1;
      try {
        await action();
      } finally {
        approvedScopes -= 1;
      }
      return true;
    },
    async navigate(load) {
      if (!mayUnload()) {
        heldTasks.set(HELD_NAVIGATION_KEY, load);
        return;
      }
      heldTasks.delete(HELD_NAVIGATION_KEY);
      await load();
    },
    runWhenClean(key, task) {
      heldTasks.set(key, task);
      runHeldTasks();
    },
  };
}
