import type { CdpSender } from "./snapshot.js";

type NavigationEntry = { id?: number; url?: string };
type NavigationHistory = { currentIndex?: number; entries?: NavigationEntry[] };

export function validateNavigationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Navigation URL must be an absolute HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Navigation URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Navigation URL must not contain embedded credentials");
  return url.toString();
}

export class NavigationController {
  constructor(private readonly cdp: CdpSender) {}

  async navigate(tabId: number, url: string): Promise<object> {
    return await this.cdp.send(tabId, "Page.navigate", { url: validateNavigationUrl(url) });
  }

  async back(tabId: number): Promise<boolean> {
    return await this.navigateHistory(tabId, -1);
  }

  async forward(tabId: number): Promise<boolean> {
    return await this.navigateHistory(tabId, 1);
  }

  async reload(tabId: number, ignoreCache = false): Promise<void> {
    await this.cdp.send(tabId, "Page.reload", { ignoreCache });
  }

  async stop(tabId: number): Promise<void> {
    await this.cdp.send(tabId, "Page.stopLoading", {});
  }

  private async navigateHistory(tabId: number, delta: number): Promise<boolean> {
    const history = await this.cdp.send(tabId, "Page.getNavigationHistory", {}) as NavigationHistory;
    const currentIndex = history.currentIndex;
    const entries = history.entries ?? [];
    if (!Number.isInteger(currentIndex)) throw new Error("Chrome navigation history is unavailable");
    const entry = entries[(currentIndex as number) + delta];
    if (!entry || !Number.isSafeInteger(entry.id)) return false;
    await this.cdp.send(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id as number });
    return true;
  }
}
