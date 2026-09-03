import { describe, expect, it, vi } from "vitest";
import { BrowserSessionRuntime, type BrowserHandoffMessage, type BrowserPrepareReturnMessage } from "../src/background/browser-session-runtime.js";
import type { BrowserCommandMessage, HumanInputMessage } from "../src/transport/protocol.js";

const visualTransport = { sendFrame: vi.fn(() => true) };

function envelope<T extends Record<string, unknown>>(type: string, payload: T) {
  return {
    protocol_version: 1,
    type,
    device_id: "bdv_1",
    session_id: "brs_1",
    surface_id: "surf_1",
    sequence: 1,
    timestamp: "2026-09-03T03:00:00.000Z",
    source: "cptr",
    mode: "AGENT_CONTROL",
    payload,
  };
}

describe("BrowserSessionRuntime handoff synchronization", () => {
  it("rejects stale agent mutation while human owns the tab, then accepts fresh returned epoch", async () => {
    const sendCommand = vi.fn<(source: chrome.debugger.Debuggee, method: string, params?: object) => Promise<object>>();
    sendCommand.mockResolvedValue({});
    const debuggerApi = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand,
      onDetach: { addListener: vi.fn() },
    };
    const tabsApi = {
      query: vi.fn(async () => []),
      get: vi.fn(async (id: number) => ({ id, windowId: 1, active: true, title: "Demo", url: "https://example.com" })),
      update: vi.fn(async (id: number) => ({ id, windowId: 1, active: true, title: "Demo", url: "https://example.com" })),
      create: vi.fn(async () => ({ id: 8, windowId: 1, active: true, url: "https://example.com" })),
      remove: vi.fn(async () => undefined),
      duplicate: vi.fn(async (id: number) => ({ id: id + 1, windowId: 1, active: false })),
    };
    vi.stubGlobal("chrome", {
      debugger: debuggerApi,
      tabs: tabsApi,
    });
    const runtime = new BrowserSessionRuntime(visualTransport as never);
    debuggerApi.sendCommand.mockImplementation(async (_source: chrome.debugger.Debuggee, method: string) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 500 } };
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Continue" } }] };
      return {};
    });

    const attach = {
      ...envelope("browser.command", { action: "attach", expected_epoch: 9, args: { tab_id: 7 } }),
      command_id: "cmd_attach",
    } as BrowserCommandMessage;
    const attached = await runtime.handle(attach);
    expect(attached.type).toBe("browser.command.completed");
    expect((attached.payload.lease as { epoch?: number }).epoch).toBe(9);

    const humanHandoff = {
      ...envelope("browser.handoff.accepted", { owner: "human", epoch: 10, snapshot_id: "snap_1" }),
      mode: "HUMAN_CONTROL",
    } as BrowserHandoffMessage;
    await runtime.syncHandoff(humanHandoff);

    const staleAgent = {
      ...envelope("browser.command", { action: "scroll", expected_epoch: 9, args: { delta_y: 100 } }),
      command_id: "cmd_stale",
      mode: "HUMAN_CONTROL",
      sequence: 2,
    } as BrowserCommandMessage;
    const rejected = await runtime.handle(staleAgent);
    expect(rejected.type).toBe("browser.command.failed");
    expect(String(rejected.payload.error)).toMatch(/lease|owner/i);

    const humanInput = {
      ...envelope("browser.human.input", { input_type: "click", expected_epoch: 10, x: 0.5, y: 0.5 }),
      command_id: "human_1",
      mode: "HUMAN_CONTROL",
      sequence: 3,
    } as HumanInputMessage;
    const humanResult = await runtime.handleHumanInput(humanInput);
    expect(humanResult.type).toBe("browser.command.completed");

    const prepareReturn = {
      ...envelope("browser.handoff.prepare_return", { expected_epoch: 10 }),
      command_id: "handoff_prepare_1",
      mode: "HUMAN_CONTROL",
      sequence: 4,
    } as BrowserPrepareReturnMessage;
    const prepared = await runtime.prepareReturn(prepareReturn);
    expect(prepared.type).toBe("browser.command.completed");
    const freshSnapshotId = String(prepared.payload.snapshot_id ?? "");
    expect(freshSnapshotId).toMatch(/^snap_/);

    const returned = {
      ...envelope("browser.handoff.returned", { owner: "agent", epoch: 11, snapshot_id: freshSnapshotId }),
      mode: "AGENT_CONTROL",
      sequence: 5,
    } as BrowserHandoffMessage;
    await runtime.syncHandoff(returned);

    const freshAgent = {
      ...envelope("browser.command", { action: "scroll", expected_epoch: 11, args: { delta_y: 100 } }),
      command_id: "cmd_fresh",
      mode: "AGENT_CONTROL",
      sequence: 6,
    } as BrowserCommandMessage;
    const accepted = await runtime.handle(freshAgent);
    expect(accepted.type).toBe("browser.command.completed");
  });
});
