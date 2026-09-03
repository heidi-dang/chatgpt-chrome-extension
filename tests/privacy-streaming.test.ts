import { describe, expect, it } from "vitest";
import { redactForTransport, redactInputEvent } from "../src/privacy/redaction.js";
import { AdaptiveStreamPolicy, LatestFrameSlot } from "../src/transport/visual-stream.js";

describe("privacy redaction", () => {
  it("redacts credential-bearing keys recursively", () => {
    const safe = redactForTransport({
      cookie: "session=secret",
      nested: {
        Authorization: "Bearer secret-token",
        refresh_token: "refresh-secret",
        title: "Safe title",
      },
    });

    expect(safe).toEqual({
      cookie: "[REDACTED]",
      nested: {
        Authorization: "[REDACTED]",
        refresh_token: "[REDACTED]",
        title: "Safe title",
      },
    });
  });

  it("never persists plaintext text for sensitive human input", () => {
    expect(redactInputEvent({
      type: "text_input",
      text: "correct horse battery staple",
      sensitive: true,
      targetRole: "textbox",
    })).toEqual({
      type: "text_input",
      text: "[REDACTED]",
      sensitive: true,
      targetRole: "textbox",
      textLength: 28,
    });
  });
});

describe("latest-frame-wins streaming", () => {
  it("keeps at most one waiting visual frame", () => {
    const frames = new LatestFrameSlot<string>();
    frames.push("frame-1");
    frames.push("frame-2");
    frames.push("frame-3");

    expect(frames.waitingCount).toBe(1);
    expect(frames.take()).toBe("frame-3");
    expect(frames.waitingCount).toBe(0);
  });

  it("streams zero visual FPS when idle or hidden", () => {
    const policy = new AdaptiveStreamPolicy();
    expect(policy.target({ mode: "OBSERVING", visible: true, interacting: false, backgrounded: false }).fps).toBe(0);
    expect(policy.target({ mode: "HUMAN_CONTROL", visible: false, interacting: true, backgrounded: false }).fps).toBe(0);
  });

  it("caps initial human-control visual streaming at 12 FPS", () => {
    const policy = new AdaptiveStreamPolicy();
    const target = policy.target({ mode: "HUMAN_CONTROL", visible: true, interacting: true, backgrounded: false });
    expect(target.fps).toBeGreaterThanOrEqual(8);
    expect(target.fps).toBeLessThanOrEqual(12);
  });
});
