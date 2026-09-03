import type { DebuggerController } from "./debugger.js";
import { sanitizeBrowserUrl } from "./tabs.js";
import { redactString } from "../privacy/redaction.js";

export type SafeNetworkEvent = {
  type: string;
  requestId: string;
  url: string;
  method?: string;
  status?: number;
  mimeType?: string;
  timestamp?: number;
};

export type SafeConsoleEvent = {
  level: string;
  text: string;
  timestamp?: number;
};

const MAX_EVENTS = 200;

export class BrowserObservabilityController {
  private readonly networkEvents: SafeNetworkEvent[] = [];
  private readonly consoleEvents: SafeConsoleEvent[] = [];
  private activeTabId: number | null = null;

  constructor(private readonly debuggerController: DebuggerController) {
    this.debuggerController.onEvent((tabId, method, params) => {
      if (tabId !== this.activeTabId) return;
      this.ingest(method, params as Record<string, unknown>);
    });
  }

  async enable(tabId: number): Promise<void> {
    this.activeTabId = tabId;
    this.networkEvents.length = 0;
    this.consoleEvents.length = 0;
    await this.debuggerController.send(tabId, "Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
    await this.debuggerController.send(tabId, "Log.enable", {});
  }

  listNetwork(): SafeNetworkEvent[] {
    return [...this.networkEvents];
  }

  listConsole(): SafeConsoleEvent[] {
    return [...this.consoleEvents];
  }

  clear(): void {
    this.networkEvents.length = 0;
    this.consoleEvents.length = 0;
    this.activeTabId = null;
  }

  private ingest(method: string, params: Record<string, unknown>): void {
    if (method === "Network.requestWillBeSent") {
      const request = params.request && typeof params.request === "object" ? params.request as Record<string, unknown> : {};
      const requestId = typeof params.requestId === "string" ? params.requestId.slice(0, 256) : "";
      const url = typeof request.url === "string" ? sanitizeBrowserUrl(request.url) : "";
      if (!requestId || !url) return;
      const event: SafeNetworkEvent = { type: "request", requestId, url };
      if (typeof request.method === "string") event.method = request.method.slice(0, 32);
      if (typeof params.timestamp === "number") event.timestamp = params.timestamp;
      this.pushNetwork(event);
      return;
    }
    if (method === "Network.responseReceived") {
      const response = params.response && typeof params.response === "object" ? params.response as Record<string, unknown> : {};
      const requestId = typeof params.requestId === "string" ? params.requestId.slice(0, 256) : "";
      const url = typeof response.url === "string" ? sanitizeBrowserUrl(response.url) : "";
      if (!requestId || !url) return;
      const event: SafeNetworkEvent = { type: "response", requestId, url };
      if (typeof response.status === "number") event.status = response.status;
      if (typeof response.mimeType === "string") event.mimeType = response.mimeType.slice(0, 256);
      if (typeof params.timestamp === "number") event.timestamp = params.timestamp;
      this.pushNetwork(event);
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = params.entry && typeof params.entry === "object" ? params.entry as Record<string, unknown> : {};
      const rawText = typeof entry.text === "string" ? entry.text : "";
      if (!rawText) return;
      const event: SafeConsoleEvent = {
        level: typeof entry.level === "string" ? entry.level.slice(0, 32) : "log",
        text: redactString(rawText).slice(0, 4_000),
      };
      if (typeof entry.timestamp === "number") event.timestamp = entry.timestamp;
      this.consoleEvents.push(event);
      if (this.consoleEvents.length > MAX_EVENTS) this.consoleEvents.splice(0, this.consoleEvents.length - MAX_EVENTS);
    }
  }

  private pushNetwork(event: SafeNetworkEvent): void {
    this.networkEvents.push(event);
    if (this.networkEvents.length > MAX_EVENTS) this.networkEvents.splice(0, this.networkEvents.length - MAX_EVENTS);
  }
}
