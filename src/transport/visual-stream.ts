import type { BrowserMode } from "./protocol.js";

export class LatestFrameSlot<T> {
  private waiting: T | undefined;

  push(frame: T): void {
    this.waiting = frame;
  }

  take(): T | undefined {
    const frame = this.waiting;
    this.waiting = undefined;
    return frame;
  }

  clear(): void {
    this.waiting = undefined;
  }

  get waitingCount(): 0 | 1 {
    return this.waiting === undefined ? 0 : 1;
  }
}

export type StreamContext = {
  mode: BrowserMode;
  visible: boolean;
  interacting: boolean;
  backgrounded: boolean;
};

export type StreamTarget = {
  fps: number;
  maxWidth: number;
  quality: number;
};

export class AdaptiveStreamPolicy {
  target(context: StreamContext): StreamTarget {
    if (!context.visible || context.backgrounded) return { fps: 0, maxWidth: 960, quality: 55 };
    if (context.mode === "HUMAN_CONTROL") {
      return context.interacting
        ? { fps: 10, maxWidth: 1_280, quality: 68 }
        : { fps: 4, maxWidth: 1_152, quality: 62 };
    }
    if (context.mode === "AGENT_CONTROL") {
      return context.interacting
        ? { fps: 4, maxWidth: 1_152, quality: 62 }
        : { fps: 0, maxWidth: 1_024, quality: 58 };
    }
    return { fps: 0, maxWidth: 960, quality: 55 };
  }
}
