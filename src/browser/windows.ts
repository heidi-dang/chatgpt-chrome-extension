export type SafeWindow = {
  id: number;
  focused: boolean;
  incognito: boolean;
  state: NonNullable<chrome.windows.Window["state"]> | "unknown";
  type: NonNullable<chrome.windows.Window["type"]> | "unknown";
  top: number | null;
  left: number | null;
  width: number | null;
  height: number | null;
};

export interface WindowsApiLike {
  getAll(getInfo?: { populate?: boolean; windowTypes?: chrome.windows.WindowType[] }): Promise<chrome.windows.Window[]>;
  create(createData?: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>;
  update(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window>;
}

function safeWindow(value: chrome.windows.Window): SafeWindow {
  if (value.id === undefined || !Number.isSafeInteger(value.id)) throw new Error("Chrome window id is unavailable");
  return {
    id: value.id,
    focused: value.focused,
    incognito: value.incognito,
    state: value.state ?? "unknown",
    type: value.type ?? "unknown",
    top: Number.isFinite(value.top) ? value.top ?? null : null,
    left: Number.isFinite(value.left) ? value.left ?? null : null,
    width: Number.isFinite(value.width) ? value.width ?? null : null,
    height: Number.isFinite(value.height) ? value.height ?? null : null,
  };
}

export class WindowsController {
  constructor(private readonly api: WindowsApiLike = chrome.windows) {}

  async list(): Promise<SafeWindow[]> {
    return (await this.api.getAll({ populate: false })).slice(0, 100).map(safeWindow);
  }

  async create(url?: string): Promise<SafeWindow> {
    const created = await this.api.create(url ? { url, focused: true } : { focused: true });
    if (!created) throw new Error("Chrome window could not be created");
    return safeWindow(created);
  }

  async focus(windowId: number): Promise<SafeWindow> {
    if (!Number.isSafeInteger(windowId) || windowId < 0) throw new Error("A valid Chrome window id is required");
    return safeWindow(await this.api.update(windowId, { focused: true }));
  }
}
