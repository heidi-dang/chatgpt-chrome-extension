import { describe, expect, it, vi } from "vitest";
import { DeviceStateRepository, type StorageAreaLike } from "../src/state/device-state.js";
import { DeviceControlTransport, type SocketLike } from "../src/transport/websocket.js";
import { PROTOCOL_VERSION } from "../src/transport/protocol.js";

class MemoryStorage implements StorageAreaLike {
  readonly values: Record<string, unknown> = {};
  async get(key: string): Promise<Record<string, unknown>> { return { [key]: this.values[key] }; }
  async set(items: Record<string, unknown>): Promise<void> { Object.assign(this.values, items); }
  async remove(key: string): Promise<void> { delete this.values[key]; }
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }

  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }

  message(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: value });
  }

  disconnect(code = 1006, reason = "network"): void {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({ code, reason });
  }
}

const deviceCredential = "device-secret-0123456789abcdef0123456789abcdef";

async function configuredRepository(): Promise<DeviceStateRepository> {
  const repo = new DeviceStateRepository(new MemoryStorage());
  await repo.save({
    cptrOrigin: "https://cptr.example.com",
    deviceId: "bdv_1",
    deviceCredential,
    deviceName: "Heidi Chrome",
    resumeSequence: 830,
  });
  return repo;
}

describe("device control WebSocket", () => {
  it("authenticates over WSS without putting the device credential in the URL", async () => {
    const repo = await configuredRepository();
    const socket = new FakeSocket();
    let openedUrl = "";
    const transport = new DeviceControlTransport({
      stateRepository: repo,
      socketFactory: (url) => { openedUrl = url; return socket; },
      onMessage: vi.fn(),
    });

    await transport.start();
    socket.open();

    expect(openedUrl).toBe("wss://cptr.example.com/api/browser-device/v1/connect/control");
    expect(openedUrl).not.toContain(deviceCredential);
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      protocol_version: PROTOCOL_VERSION,
      type: "device.authenticate",
      device_id: "bdv_1",
      device_credential: deviceCredential,
      resume_from: 830,
    });
    transport.stop();
  });

  it("accepts device heartbeats without consuming the replay sequence cursor", async () => {
    const repo = await configuredRepository();
    const socket = new FakeSocket();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const transport = new DeviceControlTransport({
      stateRepository: repo,
      socketFactory: () => socket,
      onMessage,
      onError,
    });

    await transport.start();
    socket.open();
    socket.message(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "device.authenticated", device_id: "bdv_1" }));
    socket.message(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "device.ping", device_id: "bdv_1" }));

    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect((await repo.load())?.resumeSequence).toBe(830);
    expect(socket.readyState).toBe(1);
    transport.stop();
  });

  it("drops duplicate replay events and persists the newest accepted sequence", async () => {
    const repo = await configuredRepository();
    const socket = new FakeSocket();
    const onMessage = vi.fn();
    const transport = new DeviceControlTransport({
      stateRepository: repo,
      socketFactory: () => socket,
      onMessage,
    });

    await transport.start();
    socket.open();
    socket.message(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "device.authenticated", device_id: "bdv_1" }));
    const event = (sequence: number) => JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      session_id: "brs_1",
      surface_id: "wbs_1",
      device_id: "bdv_1",
      sequence,
      timestamp: "2026-09-03T01:00:00.000Z",
      source: "cptr",
      mode: "DISCONNECTED",
      type: "browser.handoff.cancelled",
      payload: {},
    });
    socket.message(event(831));
    socket.message(event(831));
    socket.message(event(832));

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await repo.load())?.resumeSequence).toBe(832));
    transport.stop();
  });

  it("notifies browser runtimes when an authenticated control socket is lost", async () => {
    const repo = await configuredRepository();
    const socket = new FakeSocket();
    const onDisconnect = vi.fn(async () => undefined);
    const transport = new DeviceControlTransport({
      stateRepository: repo,
      socketFactory: () => socket,
      onMessage: vi.fn(),
      onDisconnect,
    });

    await transport.start();
    socket.open();
    socket.message(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "device.authenticated", device_id: "bdv_1" }));
    socket.disconnect();

    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
    transport.stop();
  });

  it("invalidates browser runtimes when an authenticated transport is explicitly stopped", async () => {
    const repo = await configuredRepository();
    const socket = new FakeSocket();
    const onDisconnect = vi.fn(async () => undefined);
    const transport = new DeviceControlTransport({
      stateRepository: repo,
      socketFactory: () => socket,
      onMessage: vi.fn(),
      onDisconnect,
    });

    await transport.start();
    socket.open();
    socket.message(JSON.stringify({ protocol_version: PROTOCOL_VERSION, type: "device.authenticated", device_id: "bdv_1" }));
    transport.stop();

    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
  });

  it("rejects malformed server messages instead of routing them", async () => {
    const repo = await configuredRepository();
    const socket = new FakeSocket();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const transport = new DeviceControlTransport({
      stateRepository: repo,
      socketFactory: () => socket,
      onMessage,
      onError,
    });

    await transport.start();
    socket.open();
    socket.message("{not-json");

    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    transport.stop();
  });
});
