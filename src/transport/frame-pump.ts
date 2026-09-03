import type { ScreenshotController } from "../browser/screenshot.js";
import type { BrowserMode } from "./protocol.js";
import { AdaptiveStreamPolicy, LatestFrameSlot } from "./visual-stream.js";
import type { DeviceVisualTransport, VisualFrameEnvelope } from "./visual-websocket.js";

export type FramePumpContext = {
  sessionId: string;
  tabId: number;
  url: string;
  mode: BrowserMode;
  visible: boolean;
  interacting: boolean;
  backgrounded: boolean;
  viewportWidth: number;
  viewportHeight: number;
};

export class BrowserFramePump {
  private readonly latest = new LatestFrameSlot<VisualFrameEnvelope>();
  private readonly policy = new AdaptiveStreamPolicy();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private context: FramePumpContext | null = null;

  constructor(
    private readonly screenshots: ScreenshotController,
    private readonly transport: DeviceVisualTransport,
  ) {}

  update(context: FramePumpContext | null): void {
    this.context = context;
    if (!context) {
      this.stopTimer();
      this.latest.clear();
      return;
    }
    this.schedule(0);
  }

  stop(): void {
    this.context = null;
    this.latest.clear();
    this.stopTimer();
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(0, delayMs));
  }

  private async tick(): Promise<void> {
    const context = this.context;
    if (!context || this.running) return;
    const target = this.policy.target(context);
    if (target.fps <= 0) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const result = await this.screenshots.capture(context.tabId, context.url, { quality: target.quality });
      if (!result.blocked && result.data) {
        const frame: VisualFrameEnvelope = {
          sessionId: context.sessionId,
          frameId: `frm_${startedAt.toString(36)}`,
          mimeType: result.mimeType,
          width: Math.max(1, Math.min(context.viewportWidth, target.maxWidth)),
          height: Math.max(1, context.viewportHeight),
          createdAtMs: startedAt,
          dataBase64: result.data,
        };
        this.latest.push(frame);
        const newest = this.latest.take();
        if (newest) this.transport.sendFrame(newest);
      }
    } catch {
      // Visual capture is best-effort. Control traffic and lease ownership must
      // remain healthy when Chrome temporarily cannot produce a screenshot.
    } finally {
      this.running = false;
      const active = this.context;
      if (active) {
        const nextTarget = this.policy.target(active);
        if (nextTarget.fps > 0) {
          const elapsed = Date.now() - startedAt;
          const interval = Math.max(1, Math.floor(1000 / nextTarget.fps));
          this.schedule(Math.max(0, interval - elapsed));
        }
      }
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
