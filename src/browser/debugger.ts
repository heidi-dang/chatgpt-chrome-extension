const CDP_PROTOCOL_VERSION = "1.3";

const ALLOWED_CDP_COMMANDS = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.focus",
  "DOM.getBoxModel",
  "DOM.getOuterHTML",
  "DOM.querySelectorAll",
  "DOM.resolveNode",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.insertText",
  "Input.synthesizeScrollGesture",
  "Log.enable",
  "Network.enable",
  "Page.enable",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.handleJavaScriptDialog",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.printToPDF",
  "Page.reload",
  "Page.stopLoading",
  "Runtime.callFunctionOn",
  "Runtime.enable",
  "Runtime.evaluate",
] as const);

export interface DebuggerApiLike {
  attach(target: chrome.debugger.Debuggee, requiredVersion: string): Promise<void>;
  detach(target: chrome.debugger.Debuggee): Promise<void>;
  sendCommand(target: chrome.debugger.Debuggee, method: string, commandParams?: object): Promise<object>;
  onDetach: {
    addListener(listener: (source: chrome.debugger.Debuggee, reason: string) => void): void;
  };
  onEvent?: {
    addListener(listener: (source: chrome.debugger.Debuggee, method: string, params?: object) => void): void;
  };
}

export class UnsupportedCdpCommandError extends Error {
  constructor(method: string) {
    super(`Unsupported CDP command: ${method}`);
    this.name = "UnsupportedCdpCommandError";
  }
}

export class DebuggerController {
  private readonly attachedTabs = new Set<number>();
  private readonly detachReasons = new Map<number, string>();
  private readonly eventListeners = new Set<(tabId: number, method: string, params: object) => void>();

  constructor(private readonly api: DebuggerApiLike = chrome.debugger as unknown as DebuggerApiLike) {
    this.api.onDetach.addListener((source, reason) => {
      if (source.tabId === undefined) return;
      this.attachedTabs.delete(source.tabId);
      this.detachReasons.set(source.tabId, reason);
    });
    this.api.onEvent?.addListener((source, method, params = {}) => {
      if (source.tabId === undefined || !this.attachedTabs.has(source.tabId)) return;
      for (const listener of this.eventListeners) listener(source.tabId, method, params);
    });
  }

  async attach(tabId: number): Promise<void> {
    this.assertTabId(tabId);
    if (this.attachedTabs.has(tabId)) return;
    await this.api.attach({ tabId }, CDP_PROTOCOL_VERSION);
    this.attachedTabs.add(tabId);
    this.detachReasons.delete(tabId);
  }

  async detach(tabId: number): Promise<void> {
    this.assertTabId(tabId);
    if (!this.attachedTabs.has(tabId)) return;
    try {
      await this.api.detach({ tabId });
    } finally {
      this.attachedTabs.delete(tabId);
    }
  }

  async send(tabId: number, method: string, params: object = {}): Promise<object> {
    this.assertTabId(tabId);
    if (!ALLOWED_CDP_COMMANDS.has(method as never)) throw new UnsupportedCdpCommandError(method);
    if (!this.attachedTabs.has(tabId)) throw new Error(`Chrome debugger is not attached to tab ${tabId}`);
    return await this.api.sendCommand({ tabId }, method, params);
  }

  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId);
  }

  lastDetachReason(tabId: number): string | null {
    return this.detachReasons.get(tabId) ?? null;
  }

  onEvent(listener: (tabId: number, method: string, params: object) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private assertTabId(tabId: number): void {
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error("A valid Chrome tab id is required");
  }
}
