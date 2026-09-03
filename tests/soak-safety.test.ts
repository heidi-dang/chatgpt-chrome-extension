import { describe, expect, it } from "vitest";
import { BrowserLease } from "../src/sessions/leases.js";
import { BoundedCommandDedupe } from "../src/transport/idempotency.js";
import { SequenceCursor } from "../src/transport/reconnect.js";

describe("browser ownership/reconnect soak", () => {
  it("survives 100 agent-human-agent cycles with monotonic epochs and stale command rejection", () => {
    const lease = new BrowserLease({ deviceId: "bdv_1", tabId: 7, sessionId: "brs_1" });
    let current = lease.acquireAgent("snap_0");
    for (let cycle = 1; cycle <= 100; cycle += 1) {
      const staleAgentEpoch = current.epoch;
      const human = lease.transferToHuman(current.epoch);
      expect(() => lease.assertMutation("agent", staleAgentEpoch)).toThrow();
      lease.assertMutation("human", human.epoch);
      current = lease.returnToAgent(human.epoch, `snap_${cycle}`);
      lease.assertMutation("agent", current.epoch);
    }
    expect(current.epoch).toBe(201);
    expect(current.owner).toBe("agent");
  });

  it("keeps replay and command-dedupe state bounded over 1000 events", () => {
    const cursor = new SequenceCursor();
    const dedupe = new BoundedCommandDedupe(128);
    for (let sequence = 1; sequence <= 1000; sequence += 1) {
      expect(cursor.accept(sequence)).toBe(true);
      expect(cursor.accept(sequence)).toBe(false);
      expect(dedupe.markIfNew(`cmd_${sequence}`)).toBe(true);
      expect(dedupe.markIfNew(`cmd_${sequence}`)).toBe(false);
    }
    expect(cursor.resumeFrom).toBe(1000);
    expect(dedupe.size).toBe(128);
    expect(dedupe.has("cmd_1")).toBe(false);
    expect(dedupe.has("cmd_1000")).toBe(true);
  });
});
