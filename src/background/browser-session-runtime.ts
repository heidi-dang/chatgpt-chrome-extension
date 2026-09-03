import { DebuggerController } from "../browser/debugger.js";
import { BrowserInputController } from "../browser/input.js";
import { HumanInputController } from "../browser/human-input.js";
import { DomInspectionController, findInSnapshot } from "../browser/dom-inspection.js";
import { DownloadsController } from "../browser/downloads.js";
import { NavigationController } from "../browser/navigation.js";
import { BrowserObservabilityController } from "../browser/observability.js";
import { PageUtilitiesController } from "../browser/page-utils.js";
import { ScreenshotController } from "../browser/screenshot.js";
import { AccessibilitySnapshotController } from "../browser/snapshot.js";
import { SnapshotRefs } from "../browser/snapshot-refs.js";
import { TabsController } from "../browser/tabs.js";
import { WindowsController } from "../browser/windows.js";
import { CanvasFrameMasker, PrivacyCurtainPolicy } from "../privacy/masking.js";
import { BrowserLease } from "../sessions/leases.js";
import { BoundedCommandDedupe } from "../transport/idempotency.js";
import type { BrowserCommandMessage, BrowserMode, HumanInputMessage, ServerMessage } from "../transport/protocol.js";
import { BrowserFramePump } from "../transport/frame-pump.js";
import type { DeviceVisualTransport } from "../transport/visual-websocket.js";
import type { BrowserSessionStateRepository } from "../state/browser-session-state.js";

export type RuntimeResult = {
  type: "browser.command.completed" | "browser.command.failed";
  commandId: string;
  payload: Record<string, unknown>;
};

export type BrowserHandoffMessage = ServerMessage & {
  type: "browser.handoff.accepted" | "browser.handoff.returned" | "browser.handoff.cancelled";
  payload: Record<string, unknown>;
};

export type BrowserPrepareReturnMessage = ServerMessage & {
  type: "browser.handoff.prepare_return";
  command_id: string;
  payload: Record<string, unknown>;
};

export class BrowserSessionRuntime {
  private readonly debuggerController = new DebuggerController();
  private readonly tabs = new TabsController();
  private readonly windows = new WindowsController();
  private readonly refs = new SnapshotRefs();
  private readonly snapshots = new AccessibilitySnapshotController(this.debuggerController, this.refs);
  private readonly input = new BrowserInputController(this.debuggerController, this.refs);
  private readonly humanInput = new HumanInputController(this.debuggerController);
  private readonly domInspection = new DomInspectionController(this.debuggerController, this.refs);
  private readonly downloads = new DownloadsController();
  private readonly navigation = new NavigationController(this.debuggerController);
  private readonly observability = new BrowserObservabilityController(this.debuggerController);
  private readonly pageUtilities = new PageUtilitiesController(this.debuggerController);
  private readonly screenshots = new ScreenshotController(
    this.debuggerController,
    new CanvasFrameMasker(),
    new PrivacyCurtainPolicy([]),
  );
  private readonly dedupe = new BoundedCommandDedupe();
  private readonly framePump: BrowserFramePump;
  private lease: BrowserLease | null = null;
  private tabId: number | null = null;
  private sessionId: string | null = null;
  private mode: BrowserMode = "DISCONNECTED";
  private latestSnapshotText = "";

  constructor(
    visualTransport: DeviceVisualTransport,
    private readonly sessionState?: BrowserSessionStateRepository,
  ) {
    this.framePump = new BrowserFramePump(this.screenshots, visualTransport);
  }

  async restore(): Promise<boolean> {
    const saved = await this.sessionState?.load();
    if (!saved) return false;
    try {
      await this.debuggerController.attach(saved.tabId);
      const tab = await this.tabs.get(saved.tabId);
      this.tabId = saved.tabId;
      this.sessionId = saved.sessionId;
      this.mode = saved.mode;
      this.lease = new BrowserLease({ deviceId: saved.deviceId, tabId: saved.tabId, sessionId: saved.sessionId });
      this.lease.restore(saved.owner, saved.epoch, saved.snapshotId);
      this.refs.invalidate();
      this.updateFramePump(tab.url, false);
      return true;
    } catch {
      await this.sessionState?.clear();
      this.stopLocal();
      return false;
    }
  }

  async handle(message: BrowserCommandMessage): Promise<RuntimeResult> {
    if (!this.dedupe.markIfNew(message.command_id)) {
      return {
        type: "browser.command.completed",
        commandId: message.command_id,
        payload: { duplicate: true },
      };
    }
    try {
      const payload = await this.execute(message);
      return { type: "browser.command.completed", commandId: message.command_id, payload };
    } catch (error) {
      return {
        type: "browser.command.failed",
        commandId: message.command_id,
        payload: { error: error instanceof Error ? error.message : "Browser command failed" },
      };
    }
  }

  async handleHumanInput(message: HumanInputMessage): Promise<RuntimeResult> {
    try {
      const tabId = this.requireTab();
      const lease = this.requireLease();
      const audit = await this.humanInput.handle(tabId, lease, message);
      this.mode = "HUMAN_CONTROL";
      await this.persist();
      this.updateFramePump((await this.tabs.get(tabId)).url, true);
      return { type: "browser.command.completed", commandId: message.command_id, payload: audit };
    } catch (error) {
      return {
        type: "browser.command.failed",
        commandId: message.command_id,
        payload: { error: error instanceof Error ? error.message : "Human browser input failed" },
      };
    }
  }

  configureStream(message: Extract<ServerMessage, { type: "browser.stream.configure" }>): void {
    if (!this.sessionId || message.session_id !== this.sessionId) return;
    this.framePump.configure({
      visible: message.payload.visible,
      maxFps: message.payload.max_fps,
      maxWidth: message.payload.max_width,
      quality: message.payload.quality,
    });
  }

  async prepareReturn(message: BrowserPrepareReturnMessage): Promise<RuntimeResult> {
    try {
      if (!this.sessionId || message.session_id !== this.sessionId) throw new Error("Browser session does not match the active tab");
      const tabId = this.requireTab();
      const lease = this.requireLease();
      const expectedEpoch = message.payload.expected_epoch;
      if (typeof expectedEpoch !== "number" || !Number.isInteger(expectedEpoch) || expectedEpoch < 0) {
        throw new Error("prepare return requires expected_epoch");
      }
      lease.assertMutation("human", expectedEpoch);
      const snapshot = await this.snapshots.capture(tabId);
      this.mode = "HUMAN_CONTROL";
      await this.persist();
      this.updateFramePump((await this.tabs.get(tabId)).url, false);
      return {
        type: "browser.command.completed",
        commandId: message.command_id,
        payload: {
          snapshot_id: snapshot.snapshotId,
          node_count: snapshot.nodeCount,
          ref_count: snapshot.refCount,
          truncated: snapshot.truncated,
        },
      };
    } catch (error) {
      return {
        type: "browser.command.failed",
        commandId: message.command_id,
        payload: { error: error instanceof Error ? error.message : "Browser handoff preparation failed" },
      };
    }
  }

  async syncHandoff(message: BrowserHandoffMessage): Promise<void> {
    if (!this.lease || !this.sessionId || message.session_id !== this.sessionId) return;
    const payload = message.payload;
    const owner = payload.owner;
    const epoch = payload.epoch;
    if (typeof owner !== "string" || typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
      throw new Error("Invalid browser handoff payload");
    }
    const current = this.lease.snapshot();
    if (epoch <= current.epoch) return;
    if (owner === "human") {
      if (current.owner !== "agent" || epoch !== current.epoch + 1) throw new Error("Unexpected human handoff epoch");
      this.lease.transferToHuman(current.epoch);
      this.mode = "HUMAN_CONTROL";
    } else if (owner === "agent") {
      const snapshotId = typeof payload.snapshot_id === "string" ? payload.snapshot_id : "";
      if (current.owner !== "human" || epoch !== current.epoch + 1 || !snapshotId) throw new Error("Unexpected agent return epoch");
      this.lease.returnToAgent(current.epoch, snapshotId);
      this.refs.invalidate();
      this.mode = "AGENT_CONTROL";
    } else if (owner === "none") {
      this.stop();
      return;
    } else {
      throw new Error("Unsupported browser handoff owner");
    }
    await this.persist();
    const tabId = this.requireTab();
    this.updateFramePump((await this.tabs.get(tabId)).url, false);
  }

  stop(): void {
    void this.sessionState?.clear();
    this.stopLocal();
  }

  private stopLocal(): void {
    this.framePump.stop();
    this.refs.invalidate();
    this.lease = null;
    this.tabId = null;
    this.sessionId = null;
    this.mode = "DISCONNECTED";
    this.latestSnapshotText = "";
    this.observability.clear();
  }

  private async execute(message: BrowserCommandMessage): Promise<Record<string, unknown>> {
    const { action, expected_epoch: expectedEpoch, args } = message.payload;
    if (action === "attach") {
      const tabId = this.requireInt(args.tab_id, "attach requires tab_id");
      await this.debuggerController.attach(tabId);
      const tab = await this.tabs.get(tabId);
      this.tabId = tabId;
      this.sessionId = message.session_id;
      this.mode = message.mode;
      this.lease = new BrowserLease({ deviceId: message.device_id, tabId, sessionId: message.session_id });
      const authoritativeEpoch = expectedEpoch ?? 1;
      const lease = this.lease.bootstrapAgent(authoritativeEpoch);
      await this.persist();
      this.updateFramePump(tab.url, false);
      return { tab, lease };
    }
    if (action === "detach") {
      const tabId = this.requireTab();
      await this.debuggerController.detach(tabId);
      this.stop();
      return { detached: true };
    }
    const tabId = this.requireTab();
    const lease = this.requireLease();
    if (expectedEpoch !== undefined) lease.assertMutation("agent", expectedEpoch);
    this.mode = message.mode;

    switch (action) {
      case "status":
        return { attached: this.debuggerController.isAttached(tabId), tab: await this.tabs.get(tabId), lease: lease.snapshot() };
      case "get_tab":
        return { tab: await this.tabs.get(tabId) };
      case "activate_tab":
        return { tab: await this.tabs.activate(this.requireInt(args.tab_id, "activate_tab requires tab_id")) };
      case "list_tabs":
        return { tabs: await this.tabs.list() };
      case "open_tab": {
        const url = typeof args.url === "string" && args.url ? args.url : undefined;
        return { tab: await this.tabs.open(url) };
      }
      case "close_tab": {
        const targetTabId = args.tab_id === undefined ? tabId : this.requireInt(args.tab_id, "close_tab requires tab_id");
        await this.tabs.close(targetTabId);
        if (targetTabId === tabId) this.stop();
        return { closed: true, tab_id: targetTabId };
      }
      case "duplicate_tab": {
        const targetTabId = args.tab_id === undefined ? tabId : this.requireInt(args.tab_id, "duplicate_tab requires tab_id");
        return { tab: await this.tabs.duplicate(targetTabId) };
      }
      case "list_windows":
        return { windows: await this.windows.list() };
      case "new_window": {
        const url = typeof args.url === "string" && args.url ? args.url : undefined;
        return { window: await this.windows.create(url) };
      }
      case "focus_window":
        return { window: await this.windows.focus(this.requireInt(args.window_id, "focus_window requires window_id")) };
      case "navigate": {
        const url = this.requireString(args.url, "navigate requires url");
        const result = await this.navigation.navigate(tabId, url);
        this.refs.invalidate();
        this.latestSnapshotText = "";
        this.updateFramePump(url, true);
        return { navigation: result };
      }
      case "back":
        this.refs.invalidate();
        this.latestSnapshotText = "";
        return { navigated: await this.navigation.back(tabId) };
      case "forward":
        this.refs.invalidate();
        this.latestSnapshotText = "";
        return { navigated: await this.navigation.forward(tabId) };
      case "reload":
        this.refs.invalidate();
        this.latestSnapshotText = "";
        await this.navigation.reload(tabId, Boolean(args.ignore_cache));
        return { reloaded: true };
      case "stop":
        await this.navigation.stop(tabId);
        return { stopped: true };
      case "snapshot": {
        const snapshot = await this.snapshots.capture(tabId);
        this.latestSnapshotText = snapshot.text;
        this.updateFramePump((await this.tabs.get(tabId)).url, false);
        return snapshot;
      }
      case "get_url":
        return { url: (await this.tabs.get(tabId)).url };
      case "get_title":
        return { title: (await this.tabs.get(tabId)).title };
      case "get_html":
        return await this.domInspection.getHtml(
          tabId,
          this.requireString(args.ref, "get_html requires ref"),
          this.requireSnapshotId(args),
        );
      case "get_text":
        return await this.domInspection.getText(
          tabId,
          this.requireString(args.ref, "get_text requires ref"),
          this.requireSnapshotId(args),
        );
      case "get_attribute":
        return await this.domInspection.getAttribute(
          tabId,
          this.requireString(args.ref, "get_attribute requires ref"),
          this.requireSnapshotId(args),
          this.requireString(args.name, "get_attribute requires name"),
        );
      case "find":
        return {
          matches: findInSnapshot(
            this.latestSnapshotText,
            this.requireString(args.query, "find requires query"),
            typeof args.max_results === "number" ? args.max_results : 50,
          ),
          snapshot_id: this.refs.currentSnapshotId,
        };
      case "screenshot": {
        const options = typeof args.quality === "number" ? { quality: args.quality } : {};
        const result = await this.screenshots.capture(tabId, (await this.tabs.get(tabId)).url, options);
        return {
          mimeType: result.mimeType,
          data: result.data,
          blocked: result.blocked,
          maskedRegions: result.maskedRegions,
        };
      }
      case "click":
        await this.input.click(tabId, this.requireString(args.ref, "click requires ref"), this.requireSnapshotId(args));
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { clicked: true };
      case "double_click":
        await this.input.click(tabId, this.requireString(args.ref, "double_click requires ref"), this.requireSnapshotId(args), { clickCount: 2 });
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { clicked: true };
      case "right_click":
        await this.input.click(tabId, this.requireString(args.ref, "right_click requires ref"), this.requireSnapshotId(args), { button: "right" });
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { clicked: true };
      case "hover":
        await this.input.hover(tabId, this.requireString(args.ref, "hover requires ref"), this.requireSnapshotId(args));
        return { hovered: true };
      case "type":
        await this.input.type(tabId, this.requireString(args.ref, "type requires ref"), this.requireSnapshotId(args), this.requireString(args.text, "type requires text"));
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { typed: true };
      case "fill":
        await this.input.fill(tabId, this.requireString(args.ref, "fill requires ref"), this.requireSnapshotId(args), this.requireString(args.text, "fill requires text"));
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { filled: true };
      case "clear":
        await this.input.clear(tabId, this.requireString(args.ref, "clear requires ref"), this.requireSnapshotId(args));
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { cleared: true };
      case "press_key":
        await this.input.pressKey(tabId, this.requireString(args.key, "press_key requires key"), typeof args.code === "string" ? args.code : undefined);
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { pressed: true };
      case "key_down":
        await this.input.keyDown(tabId, this.requireString(args.key, "key_down requires key"), typeof args.code === "string" ? args.code : undefined);
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { key_down: true };
      case "key_up":
        await this.input.keyUp(tabId, this.requireString(args.key, "key_up requires key"), typeof args.code === "string" ? args.code : undefined);
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { key_up: true };
      case "scroll":
        await this.input.scroll(
          tabId,
          typeof args.delta_x === "number" ? args.delta_x : 0,
          typeof args.delta_y === "number" ? args.delta_y : 600,
        );
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { scrolled: true };
      case "drag":
        await this.input.drag(
          tabId,
          this.requireString(args.source_ref, "drag requires source_ref"),
          this.requireString(args.target_ref, "drag requires target_ref"),
          this.requireSnapshotId(args),
        );
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { dragged: true };
      case "select_option":
        await this.input.selectOption(
          tabId,
          this.requireString(args.ref, "select_option requires ref"),
          this.requireSnapshotId(args),
          this.requireString(args.value, "select_option requires value"),
        );
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { selected: true };
      case "check":
        await this.input.setChecked(tabId, this.requireString(args.ref, "check requires ref"), this.requireSnapshotId(args), true);
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { checked: true };
      case "uncheck":
        await this.input.setChecked(tabId, this.requireString(args.ref, "uncheck requires ref"), this.requireSnapshotId(args), false);
        this.updateFramePump((await this.tabs.get(tabId)).url, true);
        return { checked: false };
      case "focus":
        await this.input.focus(tabId, this.requireString(args.ref, "focus requires ref"), this.requireSnapshotId(args));
        return { focused: true };
      case "handle_dialog":
        await this.pageUtilities.handleDialog(
          tabId,
          args.accept === undefined ? true : Boolean(args.accept),
          typeof args.prompt_text === "string" ? args.prompt_text : undefined,
        );
        return { handled: true };
      case "print_pdf":
        return await this.pageUtilities.printPdf(tabId, Boolean(args.landscape));
      case "download":
        return await this.downloads.start(this.requireString(args.url, "download requires url"));
      case "list_downloads":
        return { downloads: await this.downloads.list() };
      case "cancel_download":
        await this.downloads.cancel(this.requireInt(args.download_id, "cancel_download requires download_id"));
        return { cancelled: true };
      case "network_enable":
        await this.observability.enable(tabId);
        return { enabled: true };
      case "network_events":
        return { events: this.observability.listNetwork() };
      case "console":
        return { events: this.observability.listConsole() };
      default:
        throw new Error(`Browser action is not implemented by this extension build: ${action}`);
    }
  }

  private async persist(): Promise<void> {
    if (!this.sessionState || this.tabId === null || !this.sessionId || !this.lease) return;
    const lease = this.lease.snapshot();
    await this.sessionState.save({
      deviceId: lease.deviceId,
      sessionId: lease.sessionId,
      tabId: lease.tabId,
      mode: this.mode === "DISCONNECTED" ? "OBSERVING" : this.mode,
      owner: lease.owner,
      epoch: lease.epoch,
      snapshotId: lease.snapshotId,
    });
  }

  private updateFramePump(url: string, interacting: boolean): void {
    if (this.tabId === null || !this.sessionId) return;
    this.framePump.update({
      sessionId: this.sessionId,
      tabId: this.tabId,
      url,
      mode: this.mode,
      visible: true,
      interacting,
      backgrounded: false,
      viewportWidth: 1280,
      viewportHeight: 720,
    });
  }

  private requireTab(): number {
    if (this.tabId === null) throw new Error("No Chrome tab is attached to the browser session");
    return this.tabId;
  }

  private requireLease(): BrowserLease {
    if (!this.lease) throw new Error("Browser session lease is unavailable");
    return this.lease;
  }

  private requireSnapshotId(args: Record<string, unknown>): string {
    const snapshotId = typeof args.snapshot_id === "string" ? args.snapshot_id : this.refs.currentSnapshotId;
    if (!snapshotId) throw new Error("A current snapshot_id is required for ref-based interaction");
    return snapshotId;
  }

  private requireString(value: unknown, message: string): string {
    if (typeof value !== "string" || !value) throw new Error(message);
    return value;
  }

  private requireInt(value: unknown, message: string): number {
    if (!Number.isSafeInteger(value)) throw new Error(message);
    return value as number;
  }
}
