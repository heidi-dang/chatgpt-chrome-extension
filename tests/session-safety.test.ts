import { describe, expect, it } from "vitest";
import { BrowserLease, LeaseError } from "../src/sessions/leases.js";
import { SnapshotRefs, StaleRefError } from "../src/browser/snapshot-refs.js";

describe("browser lease ownership", () => {
  it("rejects stale agent commands after human takeover", () => {
    const lease = new BrowserLease({ deviceId: "bdv_1", tabId: 9, sessionId: "brs_1" });
    const agent = lease.acquireAgent();
    lease.transferToHuman(agent.epoch);

    expect(() => lease.assertMutation("agent", agent.epoch)).toThrow(LeaseError);
    expect(lease.owner).toBe("human");
  });

  it("increments epoch on every ownership transfer", () => {
    const lease = new BrowserLease({ deviceId: "bdv_1", tabId: 9, sessionId: "brs_1" });
    const agent = lease.acquireAgent();
    const human = lease.transferToHuman(agent.epoch);
    const returned = lease.returnToAgent(human.epoch, "snap_after_human");

    expect(human.epoch).toBe(agent.epoch + 1);
    expect(returned.epoch).toBe(human.epoch + 1);
  });

  it("requires a fresh snapshot before returning control to the agent", () => {
    const lease = new BrowserLease({ deviceId: "bdv_1", tabId: 9, sessionId: "brs_1" });
    const agent = lease.acquireAgent("snap_before");
    const human = lease.transferToHuman(agent.epoch);

    expect(() => lease.returnToAgent(human.epoch, "snap_before")).toThrow(/fresh snapshot/i);
    expect(() => lease.assertMutation("agent", agent.epoch)).toThrow(LeaseError);
  });

  it("rejects agent mutation during HUMAN_CONTROL", () => {
    const lease = new BrowserLease({ deviceId: "bdv_1", tabId: 9, sessionId: "brs_1" });
    const agent = lease.acquireAgent();
    const human = lease.transferToHuman(agent.epoch);

    expect(() => lease.assertMutation("agent", human.epoch)).toThrow(/owner/i);
    expect(() => lease.assertMutation("human", human.epoch)).not.toThrow();
  });
});

describe("snapshot-scoped refs", () => {
  it("invalidates all old refs whenever a fresh snapshot replaces the prior snapshot", () => {
    const refs = new SnapshotRefs();
    refs.replace("snap_1", new Map([["ref_18", { backendNodeId: 18 }]]));
    expect(refs.resolve("ref_18", "snap_1")).toEqual({ backendNodeId: 18 });

    refs.replace("snap_2", new Map([["ref_19", { backendNodeId: 19 }]]));

    expect(() => refs.resolve("ref_18", "snap_1")).toThrow(StaleRefError);
    expect(refs.resolve("ref_19", "snap_2")).toEqual({ backendNodeId: 19 });
  });
});
