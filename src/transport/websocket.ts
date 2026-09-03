import { z } from "zod";
import type { DeviceStateRepository, DeviceState } from "../state/device-state.js";
import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage } from "./protocol.js";
import { ReconnectPolicy, SequenceCursor } from "./reconnect.js";

export type SocketEventLike = { data?: unknown; code?: number; reason?: string };

export interface SocketLike {
  readyState: number;
  addEventListener(type: string, listener: (event: SocketEventLike) => void): void;
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export type DeviceConnectionState = "OFFLINE" | "CONNECTING" | "AUTHENTICATING" | "LIVE" | "RECONNECTING";

export type DeviceControlTransportOptions = {
  stateRepository: DeviceStateRepository;
  socketFactory?: (url: string) => SocketLike;
  reconnectPolicy?: ReconnectPolicy;
  onMessage: (message: ServerMessage) => void;
  onState?: (state: DeviceConnectionState) => void;
  onError?: (error: Error) => void;
};

const authenticatedSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  type: z.literal("device.authenticated"),
  device_id: z.string().min(1).max(200),
}).loose();

function controlWebSocketUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/browser-device/v1/connect/control";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url);
}

export class DeviceControlTransport {
  private readonly stateRepository: DeviceStateRepository;
  private readonly socketFactory: (url: string) => SocketLike;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly onMessage: (message: ServerMessage) => void;
  private readonly onState: (state: DeviceConnectionState) => void;
  private readonly onError: (error: Error) => void;
  private readonly cursor = new SequenceCursor();
  private socket: SocketLike | null = null;
  private deviceState: DeviceState | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private authenticated = false;

  constructor(options: DeviceControlTransportOptions) {
    this.stateRepository = options.stateRepository;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectPolicy = options.reconnectPolicy ?? new ReconnectPolicy();
    this.onMessage = options.onMessage;
    this.onState = options.onState ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<boolean> {
    this.stop();
    this.stopped = false;
    const state = await this.stateRepository.load();
    if (!state) {
      this.stopped = true;
      this.onState("OFFLINE");
      return false;
    }
    this.deviceState = state;
    this.cursor.reset(state.resumeSequence);
    this.connect(false);
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.authenticated = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, "client stop");
    this.onState("OFFLINE");
  }

  private connect(reconnecting: boolean): void {
    const state = this.deviceState;
    if (this.stopped || !state) return;
    this.authenticated = false;
    this.onState(reconnecting ? "RECONNECTING" : "CONNECTING");
    let socket: SocketLike;
    try {
      socket = this.socketFactory(controlWebSocketUrl(state.cptrOrigin));
    } catch (error) {
      this.handleConnectionFailure(error);
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.stopped || socket !== this.socket) return;
      this.onState("AUTHENTICATING");
      socket.send(JSON.stringify({
        protocol_version: PROTOCOL_VERSION,
        type: "device.authenticate",
        device_id: state.deviceId,
        device_credential: state.deviceCredential,
        resume_from: this.cursor.resumeFrom,
        capabilities: {
          control: true,
          visual: true,
          human_input: true,
          debugger: true,
        },
      }));
    });
    socket.addEventListener("message", (event) => {
      if (this.stopped || socket !== this.socket) return;
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.authenticated = false;
      if (!this.stopped) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (!this.stopped && socket === this.socket) this.onError(new Error("CPTR browser-device WebSocket error"));
    });
  }

  private handleMessage(raw: unknown): void {
    try {
      if (typeof raw !== "string") throw new Error("CPTR control channel accepts JSON text messages only");
      const decoded: unknown = JSON.parse(raw);
      const authenticated = authenticatedSchema.safeParse(decoded);
      if (authenticated.success) {
        if (authenticated.data.device_id !== this.deviceState?.deviceId) throw new Error("Device authentication response does not match this device");
        this.authenticated = true;
        this.reconnectAttempt = 0;
        this.onState("LIVE");
        return;
      }
      if (!this.authenticated) throw new Error("Received browser message before device authentication completed");
      const message = parseServerMessage(decoded);
      if (message.device_id !== this.deviceState?.deviceId) throw new Error("Browser message targets a different device");
      if (!this.cursor.accept(message.sequence)) return;
      void this.stateRepository.updateResumeSequence(message.sequence).catch((error: unknown) => {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
      this.onMessage(message);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.onError(normalized);
      this.socket?.close(1008, "invalid browser-device message");
    }
  }

  private handleConnectionFailure(error: unknown): void {
    this.onError(error instanceof Error ? error : new Error(String(error)));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.reconnectPolicy.delayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.onState("RECONNECTING");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(true);
    }, delay);
  }
}
