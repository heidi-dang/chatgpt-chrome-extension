import { describe, expect, it } from "vitest";
import { BoundedCommandDedupe } from "../src/transport/idempotency.js";
import { ReconnectPolicy, SequenceCursor } from "../src/transport/reconnect.js";

describe("reconnect and resume", () => {
  it("uses bounded exponential backoff with jitter", () => {
    const policy = new ReconnectPolicy({ baseMs: 500, maxMs: 8_000, jitterRatio: 0.2, random: () => 0.5 });
    expect([0, 1, 2, 3, 4, 8].map((attempt) => policy.delayMs(attempt))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 8_000,
    ]);
  });

  it("resumes strictly after the last accepted sequence and drops replay duplicates", () => {
    const cursor = new SequenceCursor();
    expect(cursor.accept(828)).toBe(true);
    expect(cursor.accept(829)).toBe(true);
    expect(cursor.accept(830)).toBe(true);
    expect(cursor.resumeFrom).toBe(830);
    expect(cursor.accept(830)).toBe(false);
    expect(cursor.accept(829)).toBe(false);
    expect(cursor.accept(831)).toBe(true);
    expect(cursor.resumeFrom).toBe(831);
  });
});

describe("command idempotency", () => {
  it("does not execute a command twice after reconnect replay", () => {
    const dedupe = new BoundedCommandDedupe(3);
    expect(dedupe.markIfNew("cmd_1")).toBe(true);
    expect(dedupe.markIfNew("cmd_1")).toBe(false);
  });

  it("remains bounded and evicts oldest command ids", () => {
    const dedupe = new BoundedCommandDedupe(2);
    dedupe.markIfNew("cmd_1");
    dedupe.markIfNew("cmd_2");
    dedupe.markIfNew("cmd_3");
    expect(dedupe.size).toBe(2);
    expect(dedupe.has("cmd_1")).toBe(false);
    expect(dedupe.has("cmd_2")).toBe(true);
    expect(dedupe.has("cmd_3")).toBe(true);
  });
});
