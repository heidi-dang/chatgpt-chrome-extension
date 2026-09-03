import { describe, expect, it, vi } from "vitest";
import { DeviceVisualTransport, type VisualSocketLike } from "../src/transport/visual-websocket.js";
import { BrowserFramePump } from "../src/transport/frame-pump.js";

class FakeSocket implements VisualSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const stateRepository = {
  load: vi.fn(async () => ({
    cptrOrigin: "https://cptr.example.com",
    deviceId: "bdv_1",
    deviceCredential: "x".repeat(48),
    deviceName: "Heidi Chrome",
    resumeSequence: 0,
  })),
  updateResumeSequence: vi.fn(async () => undefined),
};

describe("visual transport", () => {
  it("authenticates on a dedicated visual WebSocket and never puts credentials in the URL", async () => {
    const socket = new FakeSocket();
    let url = "";
    const transport = new DeviceVisualTransport({
      stateRepository: stateRepository as never,
      socketFactory: (value) => { url = value; return socket; },
    });

    await transport.start();
    socket.emit("open");
    expect(url).toBe("wss://cptr.example.com/api/browser-device/v1/connect/visual");
    expect(url).not.toContain("credential");
    const auth = JSON.parse(socket.sent[0] ?? "{}") as Record<string, unknown>;
    expect(auth.type).toBe("device.authenticate");
    expect(auth.device_credential).toBe("x".repeat(48));
  });

  it("drops visual frames under socket backpressure", async () => {
    const socket = new FakeSocket();
    const transport = new DeviceVisualTransport({
      stateRepository: stateRepository as never,
      socketFactory: () => socket,
    });
    await transport.start();
    socket.emit("open");
    socket.emit("message", { data: JSON.stringify({ protocol_version: 1, type: "device.visual_authenticated", device_id: "bdv_1" }) });
    socket.bufferedAmount = 600 * 1024;
    expect(transport.sendFrame({
      sessionId: "brs_1",
      frameId: "frm_1",
      mimeType: "image/jpeg",
      width: 800,
      height: 600,
      createdAtMs: 1,
      dataBase64: "abc",
    })).toBe(false);
  });
});

describe("browser frame pump", () => {
  it("captures no frames while hidden/idle and captures masked frames when human interaction is active", async () => {
    vi.useFakeTimers();
    const screenshots = { capture: vi.fn(async () => ({ mimeType: "image/jpeg" as const, data: "masked", blocked: false, maskedRegions: 1 })) };
    const transport = { sendFrame: vi.fn(() => true) };
    const pump = new BrowserFramePump(screenshots as never, transport as never);

    pump.update({
      sessionId: "brs_1", tabId: 7, url: "https://example.com", mode: "HUMAN_CONTROL",
      visible: false, interacting: true, backgrounded: false, viewportWidth: 1200, viewportHeight: 800,
    });
    await vi.runOnlyPendingTimersAsync();
    expect(screenshots.capture).not.toHaveBeenCalled();

    pump.update({
      sessionId: "brs_1", tabId: 7, url: "https://example.com", mode: "HUMAN_CONTROL",
      visible: true, interacting: true, backgrounded: false, viewportWidth: 1200, viewportHeight: 800,
    });
    await vi.runOnlyPendingTimersAsync();
    expect(screenshots.capture).toHaveBeenCalledTimes(1);
    expect(transport.sendFrame).toHaveBeenCalledWith(expect.objectContaining({ dataBase64: "masked", sessionId: "brs_1" }));

    pump.configure({ visible: false, maxFps: 0, maxWidth: 960, quality: 55 });
    await vi.runOnlyPendingTimersAsync();
    expect(screenshots.capture).toHaveBeenCalledTimes(1);

    pump.configure({ visible: true, maxFps: 10, maxWidth: 1280, quality: 68 });
    await vi.runOnlyPendingTimersAsync();
    expect(screenshots.capture).toHaveBeenCalledTimes(2);

    pump.stop();
    vi.useRealTimers();
  });

  it("emits an idle visible agent-control keepalive frame", async () => {
    vi.useFakeTimers();
    const screenshots = { capture: vi.fn(async () => ({ mimeType: "image/jpeg" as const, data: "idle-agent", blocked: false, maskedRegions: 0 })) };
    const transport = { sendFrame: vi.fn(() => true) };
    const pump = new BrowserFramePump(screenshots as never, transport as never);

    pump.update({
      sessionId: "brs_agent", tabId: 8, url: "https://example.com", mode: "AGENT_CONTROL",
      visible: true, interacting: false, backgrounded: false, viewportWidth: 1200, viewportHeight: 800,
    });
    await vi.runOnlyPendingTimersAsync();

    expect(screenshots.capture).toHaveBeenCalledTimes(1);
    expect(transport.sendFrame).toHaveBeenCalledWith(expect.objectContaining({ dataBase64: "idle-agent", sessionId: "brs_agent" }));
    pump.stop();
    vi.useRealTimers();
  });
});
