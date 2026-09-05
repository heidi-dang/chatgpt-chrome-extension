import type { BrowserSessionStateRepository } from "../state/browser-session-state.js";
import type { BrowserCommandMessage, HumanInputMessage, ServerMessage } from "../transport/protocol.js";
import type { DeviceVisualTransport } from "../transport/visual-websocket.js";
import {
  BrowserSessionRuntime,
  type BrowserHandoffMessage,
  type BrowserPrepareReturnMessage,
  type RuntimeResult,
} from "./browser-session-runtime.js";

type StreamConfigureMessage = Extract<ServerMessage, { type: "browser.stream.configure" }>;

/**
 * Owns one independent browser runtime per CPTR browser session.
 *
 * A Chrome extension service worker is process-global, while CPTR may have
 * multiple ChatGPT conversations controlling different tabs on the same
 * paired device. Keeping runtime state in a singleton lets a later attach
 * overwrite the tab/lease used by an earlier session. This registry keys all
 * mutable browser runtime state by session_id so commands, refs, debugger
 * targets, frame pumps, and persisted recovery state remain isolated.
 */
export class BrowserSessionRuntimeRegistry {
  private readonly runtimes = new Map<string, BrowserSessionRuntime>();
  private readonly discoveryRuntime: BrowserSessionRuntime;

  constructor(
    private readonly visualTransport: DeviceVisualTransport,
    private readonly sessionState: BrowserSessionStateRepository,
  ) {
    this.discoveryRuntime = new BrowserSessionRuntime(visualTransport);
  }

  async discardPersisted(): Promise<number> {
    const persisted = await this.sessionState.loadAll();
    await this.sessionState.clear();
    return persisted.length;
  }

  async closeAll(): Promise<number> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    let firstError: Error | null = null;
    for (const runtime of runtimes) {
      try {
        await runtime.close();
      } catch (error) {
        firstError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    await this.sessionState.clear();
    if (firstError) throw firstError;
    return runtimes.length;
  }

  async handleCommand(message: BrowserCommandMessage): Promise<RuntimeResult> {
    if (message.payload.action === "list_tabs") {
      return await this.discoveryRuntime.handle(message);
    }

    const runtime = await this.runtimeFor(message.session_id, message.payload.action !== "attach");
    const result = await runtime.handle(message);
    if (message.payload.action === "detach" && result.type === "browser.command.completed") {
      this.runtimes.delete(message.session_id);
    }
    return result;
  }

  async handleHumanInput(message: HumanInputMessage): Promise<RuntimeResult> {
    return await (await this.runtimeFor(message.session_id, true)).handleHumanInput(message);
  }

  async configureStream(message: StreamConfigureMessage): Promise<void> {
    (await this.runtimeFor(message.session_id, true)).configureStream(message);
  }

  async prepareReturn(message: BrowserPrepareReturnMessage): Promise<RuntimeResult> {
    return await (await this.runtimeFor(message.session_id, true)).prepareReturn(message);
  }

  async syncHandoff(message: BrowserHandoffMessage): Promise<void> {
    const runtime = await this.runtimeFor(message.session_id, true);
    await runtime.syncHandoff(message);
    if (message.payload.owner === "none") this.runtimes.delete(message.session_id);
  }

  async stopSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) await runtime.close();
    else await this.sessionState.clear(sessionId);
    this.runtimes.delete(sessionId);
  }

  private createRuntime(): BrowserSessionRuntime {
    return new BrowserSessionRuntime(this.visualTransport, this.sessionState);
  }

  private async runtimeFor(sessionId: string, restore: boolean): Promise<BrowserSessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;

    const runtime = this.createRuntime();
    if (restore) await runtime.restore(sessionId);
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }
}
