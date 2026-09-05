import { describe, expect, it, vi } from "vitest";
import { BrowserSessionRuntimeRegistry } from "../src/background/browser-session-registry.js";
import type { BrowserCommandMessage } from "../src/transport/protocol.js";

type SavedState = {
  deviceId: string;
  sessionId: string;
  tabId: number;
  mode: "OBSERVING" | "AGENT_CONTROL" | "HANDOFF_REQUIRED" | "HUMAN_CONTROL";
  owner: "none" | "agent" | "human";
  epoch: number;
  snapshotId: string | null;
};

function command(
  sessionId: string,
  commandId: string,
  action: string,
  args: Record<string, unknown> = {},
  expectedEpoch?: number,
): BrowserCommandMessage {
  return {
    protocol_version: 1,
    type: "browser.command",
    device_id: "bdv_1",
    session_id: sessionId,
    surface_id: `surf_${sessionId}`,
    sequence: 1,
    timestamp: "2026-09-03T08:00:00.000Z",
    source: "cptr",
    mode: "AGENT_CONTROL",
    command_id: commandId,
    payload: {
      action: action as BrowserCommandMessage["payload"]["action"],
      ...(expectedEpoch === undefined ? {} : { expected_epoch: expectedEpoch }),
      args,
    },
  };
}

describe("BrowserSessionRuntimeRegistry", () => {
  it("keeps simultaneous CPTR sessions bound to their own Chrome tabs", async () => {
    const debuggerApi = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: vi.fn() },
    };
    const tabs = new Map<number, Partial<chrome.tabs.Tab>>([
      [7, { id: 7, windowId: 1, active: false, title: "GitHub session", url: "https://github.com/example/repo", pinned: false, incognito: false, status: "complete" }],
      [8, { id: 8, windowId: 1, active: true, title: "Replit session", url: "https://replit.com/example", pinned: false, incognito: false, status: "complete" }],
    ]);
    const tabsApi = {
      query: vi.fn(async () => [...tabs.values()]),
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`missing tab ${id}`);
        return tab;
      }),
      update: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      duplicate: vi.fn(),
    };
    vi.stubGlobal("chrome", { debugger: debuggerApi, tabs: tabsApi });

    const saved = new Map<string, SavedState>();
    const sessionState = {
      load: vi.fn(async (sessionId?: string) => sessionId ? saved.get(sessionId) ?? null : [...saved.values()][0] ?? null),
      loadAll: vi.fn(async () => [...saved.values()]),
      save: vi.fn(async (state: SavedState) => { saved.set(state.sessionId, state); }),
      clear: vi.fn(async (sessionId?: string) => { if (sessionId) saved.delete(sessionId); else saved.clear(); }),
    };
    const visualTransport = { sendFrame: vi.fn(() => true) };
    const registry = new BrowserSessionRuntimeRegistry(visualTransport as never, sessionState as never);

    expect((await registry.handleCommand(command("brs_github", "attach_github", "attach", { tab_id: 7 }, 1))).type).toBe("browser.command.completed");
    expect((await registry.handleCommand(command("brs_replit", "attach_replit", "attach", { tab_id: 8 }, 1))).type).toBe("browser.command.completed");

    const githubTitle = await registry.handleCommand(command("brs_github", "title_github", "get_title"));
    const replitTitle = await registry.handleCommand(command("brs_replit", "title_replit", "get_title"));

    expect(githubTitle.payload).toEqual({ title: "GitHub session" });
    expect(replitTitle.payload).toEqual({ title: "Replit session" });
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 7 }, "1.3");
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 8 }, "1.3");
    expect(saved.get("brs_github")?.tabId).toBe(7);
    expect(saved.get("brs_replit")?.tabId).toBe(8);

    await registry.stopSession("brs_github");
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 7 });
    await registry.handleCommand(command("brs_replit", "detach_replit", "detach"));
  });

  it("detaches every active debugger runtime and clears mirrors after control-channel loss", async () => {
    const debuggerApi = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: vi.fn() },
    };
    const tabs = new Map<number, Partial<chrome.tabs.Tab>>([
      [7, { id: 7, windowId: 1, active: false, title: "GitHub", url: "https://github.com", pinned: false, incognito: false, status: "complete" }],
      [8, { id: 8, windowId: 1, active: true, title: "Docs", url: "https://example.com", pinned: false, incognito: false, status: "complete" }],
    ]);
    const tabsApi = {
      query: vi.fn(async () => [...tabs.values()]),
      get: vi.fn(async (id: number) => tabs.get(id) as chrome.tabs.Tab),
      update: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      duplicate: vi.fn(),
    };
    vi.stubGlobal("chrome", { debugger: debuggerApi, tabs: tabsApi });

    const saved = new Map<string, SavedState>();
    const sessionState = {
      load: vi.fn(async (sessionId?: string) => sessionId ? saved.get(sessionId) ?? null : [...saved.values()][0] ?? null),
      loadAll: vi.fn(async () => [...saved.values()]),
      save: vi.fn(async (state: SavedState) => { saved.set(state.sessionId, state); }),
      clear: vi.fn(async (sessionId?: string) => { if (sessionId) saved.delete(sessionId); else saved.clear(); }),
    };
    const registry = new BrowserSessionRuntimeRegistry(
      { sendFrame: vi.fn(() => true) } as never,
      sessionState as never,
    );

    await registry.handleCommand(command("brs_1", "attach_1", "attach", { tab_id: 7 }, 1));
    await registry.handleCommand(command("brs_2", "attach_2", "attach", { tab_id: 8 }, 1));
    expect(saved.size).toBe(2);

    await registry.closeAll();

    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 7 });
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 8 });
    expect(saved.size).toBe(0);
  });

  it("discards persisted session mirrors at startup instead of reattaching stale backend leases", async () => {
    const sessionState = {
      load: vi.fn(),
      loadAll: vi.fn(async () => [
        { deviceId: "bdv_1", sessionId: "brs_stale", tabId: 7, mode: "AGENT_CONTROL", owner: "agent", epoch: 3, snapshotId: null },
      ]),
      save: vi.fn(),
      clear: vi.fn(async () => undefined),
    };
    const registry = new BrowserSessionRuntimeRegistry(
      { sendFrame: vi.fn(() => true) } as never,
      sessionState as never,
    );

    expect(await registry.discardPersisted()).toBe(1);
    expect(sessionState.clear).toHaveBeenCalledWith();
  });
});
