import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type BrowserCommandMessage,
} from "../src/transport/protocol.js";

describe("browser wire protocol", () => {
  it("accepts a versioned browser command envelope", () => {
    const value = parseServerMessage({
      protocol_version: PROTOCOL_VERSION,
      session_id: "brs_session",
      surface_id: "wbs_surface",
      device_id: "bdv_device",
      sequence: 42,
      timestamp: "2026-09-03T01:00:00.000Z",
      source: "cptr",
      mode: "AGENT_CONTROL",
      type: "browser.command",
      command_id: "cmd_42",
      payload: {
        action: "click",
        expected_epoch: 7,
        args: { ref: "ref_18", snapshot_id: "snap_9" },
      },
    });

    expect(value.type).toBe("browser.command");
    expect((value as BrowserCommandMessage).payload.expected_epoch).toBe(7);
  });

  it("rejects unknown protocol versions", () => {
    expect(() => parseServerMessage({
      protocol_version: PROTOCOL_VERSION + 1,
      session_id: "brs_session",
      surface_id: "wbs_surface",
      device_id: "bdv_device",
      sequence: 1,
      timestamp: "2026-09-03T01:00:00.000Z",
      source: "cptr",
      mode: "OBSERVING",
      type: "browser.ping",
      payload: {},
    })).toThrow(/protocol/i);
  });

  it("rejects malformed and unsupported browser actions", () => {
    expect(() => parseServerMessage({
      protocol_version: PROTOCOL_VERSION,
      session_id: "brs_session",
      surface_id: "wbs_surface",
      device_id: "bdv_device",
      sequence: 2,
      timestamp: "2026-09-03T01:00:00.000Z",
      source: "cptr",
      mode: "AGENT_CONTROL",
      type: "browser.command",
      command_id: "cmd_bad",
      payload: { action: "steal_cookies", expected_epoch: 1, args: {} },
    })).toThrow(/action|invalid/i);
  });

  it("does not advertise the intentionally unsupported upload_file action", () => {
    expect(() => parseServerMessage({
      protocol_version: PROTOCOL_VERSION,
      session_id: "brs_session",
      surface_id: "wbs_surface",
      device_id: "bdv_device",
      sequence: 3,
      timestamp: "2026-09-03T01:00:00.000Z",
      source: "cptr",
      mode: "AGENT_CONTROL",
      type: "browser.command",
      command_id: "cmd_upload",
      payload: { action: "upload_file", expected_epoch: 1, args: {} },
    })).toThrow(/action|invalid/i);
  });

  it("requires an epoch for mutating agent commands", () => {
    expect(() => parseServerMessage({
      protocol_version: PROTOCOL_VERSION,
      session_id: "brs_session",
      surface_id: "wbs_surface",
      device_id: "bdv_device",
      sequence: 3,
      timestamp: "2026-09-03T01:00:00.000Z",
      source: "cptr",
      mode: "AGENT_CONTROL",
      type: "browser.command",
      command_id: "cmd_click",
      payload: { action: "click", args: { ref: "ref_1" } },
    })).toThrow(/epoch/i);
  });
});
