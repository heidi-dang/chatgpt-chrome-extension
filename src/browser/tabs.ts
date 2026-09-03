const SENSITIVE_QUERY_KEY = /(?:token|secret|password|passwd|credential|authorization|auth|api[_-]?key|access[_-]?key|refresh[_-]?token|session)/i;

export type SafeTab = {
  id: number;
  windowId: number;
  active: boolean;
  title: string;
  url: string;
  status: NonNullable<chrome.tabs.Tab["status"]> | "unknown";
  pinned: boolean;
  incognito: boolean;
};

export interface TabsApiLike {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  update(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>;
  create(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  remove(tabIds: number | number[]): Promise<void>;
  duplicate(tabId: number): Promise<chrome.tabs.Tab | undefined>;
}

export function sanitizeBrowserUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}//`;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeTab(tab: chrome.tabs.Tab): SafeTab {
  if (tab.id === undefined || !Number.isSafeInteger(tab.id)) throw new Error("Chrome tab id is unavailable");
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    title: (tab.title ?? "").slice(0, 512),
    url: sanitizeBrowserUrl(tab.url),
    status: tab.status ?? "unknown",
    pinned: tab.pinned,
    incognito: tab.incognito,
  };
}

export class TabsController {
  constructor(private readonly api: TabsApiLike = chrome.tabs) {}

  async list(): Promise<SafeTab[]> {
    return (await this.api.query({})).slice(0, 200).map(safeTab);
  }

  async get(tabId: number): Promise<SafeTab> {
    return safeTab(await this.api.get(tabId));
  }

  async activate(tabId: number): Promise<SafeTab> {
    const tab = await this.api.update(tabId, { active: true });
    if (!tab) throw new Error(`Chrome tab ${tabId} no longer exists`);
    return safeTab(tab);
  }

  async open(url?: string): Promise<SafeTab> {
    const tab = await this.api.create(url ? { url, active: true } : { active: true });
    return safeTab(tab);
  }

  async close(tabId: number): Promise<void> {
    await this.api.remove(tabId);
  }

  async duplicate(tabId: number): Promise<SafeTab> {
    const tab = await this.api.duplicate(tabId);
    if (!tab) throw new Error(`Chrome tab ${tabId} could not be duplicated`);
    return safeTab(tab);
  }
}
