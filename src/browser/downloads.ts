import { sanitizeBrowserUrl } from "./tabs.js";

export type SafeDownload = {
  id: number;
  url: string;
  filename: string;
  state: string;
  paused: boolean;
  danger: string;
  bytesReceived: number;
  totalBytes: number;
};

export interface DownloadsApiLike {
  download(options: chrome.downloads.DownloadOptions): Promise<number>;
  search(query: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
  cancel(downloadId: number): Promise<void>;
}

function safeDownload(item: chrome.downloads.DownloadItem): SafeDownload {
  return {
    id: item.id,
    url: sanitizeBrowserUrl(item.url),
    filename: item.filename.split(/[\\/]/).at(-1)?.slice(0, 512) ?? "",
    state: item.state,
    paused: item.paused,
    danger: item.danger,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
  };
}

function normalizeDownloadUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Download URL must use HTTP(S)");
  if (url.username || url.password) throw new Error("Download URL must not contain embedded credentials");
  return url.toString();
}

export class DownloadsController {
  constructor(private readonly api: DownloadsApiLike = chrome.downloads) {}

  async start(url: string): Promise<{ downloadId: number }> {
    const downloadId = await this.api.download({ url: normalizeDownloadUrl(url), saveAs: false });
    return { downloadId };
  }

  async list(): Promise<SafeDownload[]> {
    return (await this.api.search({})).slice(0, 100).map(safeDownload);
  }

  async cancel(downloadId: number): Promise<void> {
    if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error("A valid download id is required");
    await this.api.cancel(downloadId);
  }
}
