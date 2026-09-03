import type { DeviceStateRepository, DeviceState } from "../state/device-state.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { ReconnectPolicy } from "./reconnect.js";

export interface VisualSocketLike {
  readyState: number;
  bufferedAmount?: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export type VisualFrameEnvelope = {
  sessionId: string;
  frameId: string;
  mimeType: "image/jpeg" | "image/webp";
  width: number;
  height: number;
  createdAtMs: number;
  dataBase64: string;
};

export type DeviceVisualTransportOptions = {
  stateRepository: DeviceStateRepository;
  socketFactory?: (url: string) => VisualSocketLike;
  reconnectPolicy?: ReconnectPolicy;
  onError?: (error: Error) => void;
};

const MAX_BUFFERED_BYTES = 512 * 1024;

function visualWebSocketUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/browser-device/v1/connect/visual";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function defaultSocketFactory(url: string): VisualSocketLike {
  return new WebSocket(url);
}

export class DeviceVisualTransport {
  private readonly stateRepository: DeviceStateRepository;
  private readonly socketFactory: (url: string) => VisualSocketLike;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly onError: (error: Error) => void;
  private socket: VisualSocketLike | null = null;
  private state: DeviceState | null = null;
  private stopped = true;
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DeviceVisualTransportOptions) {
    this.stateRepository = options.stateRepository;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectPolicy = options.reconnectPolicy ?? new ReconnectPolicy();
    this.onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<boolean> {
    this.stop();
    this.stopped = false;
    this.state = await this.stateRepository.load();
    if (!this.state) {
      this.stopped = true;
      return false;
    }
    this.connect();
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.authenticated = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, "client stop");
  }

  sendFrame(frame: VisualFrameEnvelope): boolean {
    const socket = this.socket;
    const state = this.state;
    if (!socket || !state || !this.authenticated || socket.readyState !== 1) return false;
    if ((socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) return false;
    socket.send(JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      type: "browser.frame",
      device_id: state.deviceId,
      session_id: frame.sessionId,
      frame_id: frame.frameId,
      mime_type: frame.mimeType,
      width: frame.width,
      height: frame.height,
      created_at_ms: frame.createdAtMs,
      data_base64: frame.dataBase64,
    }));
    return true;
  }

  private connect(): void {
    const state = this.state;
    if (this.stopped || !state) return;
    this.authenticated = false;
    let socket: VisualSocketLike;
    try {
      socket = this.socketFactory(visualWebSocketUrl(state.cptrOrigin));
    } catch (error) {
      this.fail(error);
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket || this.stopped) return;
      socket.send(JSON.stringify({
        protocol_version: PROTOCOL_VERSION,
        type: "device.authenticate",
        device_id: state.deviceId,
        device_credential: state.deviceCredential,
        resume_from: 0,
      }));
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket || this.stopped || typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (
          message.protocol_version === PROTOCOL_VERSION &&
          message.type === "device.visual_authenticated" &&
          message.device_id === state.deviceId
        ) {
          this.authenticated = true;
          this.reconnectAttempt = 0;
        }
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.authenticated = false;
      if (!this.stopped) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (!this.stopped && socket === this.socket) this.onError(new Error("CPTR browser visual WebSocket error"));
    });
  }

  private fail(error: unknown): void {
    this.onError(error instanceof Error ? error : new Error(String(error)));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectPolicy.delayMs(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
