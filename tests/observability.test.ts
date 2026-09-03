import { describe, expect, it, vi } from "vitest";
import { DebuggerController, type DebuggerApiLike } from "../src/browser/debugger.js";
import { BrowserObservabilityController } from "../src/browser/observability.js";

describe("bounded browser observability", () => {
  it("drops bodies/headers, sanitizes URLs, redacts console text, and caps buffers", async () => {
    const eventListeners: Array<(source: chrome.debugger.Debuggee, method: string, params?: object) => void> = [];
    const api: DebuggerApiLike = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: () => undefined },
      onEvent: { addListener: (listener) => eventListeners.push(listener) },
    };
    const debuggerController = new DebuggerController(api);
    await debuggerController.attach(7);
    const observability = new BrowserObservabilityController(debuggerController);
    await observability.enable(7);

    eventListeners[0]?.({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId: "req_1",
      timestamp: 1,
      request: {
        url: "https://example.com/api?token=secret",
        method: "POST",
        headers: { Authorization: "Bearer top-secret", Cookie: "session=abc" },
        postData: "password=hunter2",
      },
    });
    eventListeners[0]?.({ tabId: 7 }, "Network.responseReceived", {
      requestId: "req_1",
      timestamp: 2,
      response: {
        url: "https://example.com/api?token=secret",
        status: 200,
        mimeType: "application/json",
        headers: { "Set-Cookie": "session=xyz" },
      },
    });
    eventListeners[0]?.({ tabId: 7 }, "Log.entryAdded", {
      entry: { level: "error", text: "Authorization: Bearer abc.def", timestamp: 3 },
    });

    const network = observability.listNetwork();
    const consoleEvents = observability.listConsole();
    expect(network).toHaveLength(2);
    expect(network[0]).toEqual({
      type: "request",
      requestId: "req_1",
      url: "https://example.com/api?token=%5BREDACTED%5D",
      method: "POST",
      timestamp: 1,
    });
    expect(JSON.stringify(network)).not.toMatch(/Authorization|Cookie|postData|hunter2|top-secret/i);
    expect(consoleEvents[0]?.text).toBe("Authorization: Bearer [REDACTED]");

    for (let index = 0; index < 250; index += 1) {
      eventListeners[0]?.({ tabId: 7 }, "Log.entryAdded", { entry: { level: "info", text: `line-${index}` } });
    }
    expect(observability.listConsole()).toHaveLength(200);
  });
});
