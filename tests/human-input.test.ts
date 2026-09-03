import { describe, expect, it } from "vitest";
import { HumanInputController } from "../src/browser/human-input.js";
import { BrowserLease } from "../src/sessions/leases.js";
import { PROTOCOL_VERSION, type HumanInputMessage } from "../src/transport/protocol.js";

class FakeCdp {
  readonly calls: Array<{ method: string; params: object }> = [];
  async send(_tabId: number, method: string, params: object = {}): Promise<object> {
    this.calls.push({ method, params });
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { clientWidth: 1000, clientHeight: 500 } };
    }
    return {};
  }
}

function message(epoch: number, payload: HumanInputMessage["payload"]): HumanInputMessage {
  return {
    protocol_version: PROTOCOL_VERSION,
    session_id: "brs_1",
    surface_id: "wbs_1",
    device_id: "bdv_1",
    sequence: 1,
    timestamp: "2026-09-03T01:00:00.000Z",
    source: "live_ui",
    mode: "HUMAN_CONTROL",
    type: "browser.human.input",
    command_id: "human_1",
    payload: { ...payload, expected_epoch: epoch },
  };
}

describe("human realtime input", () => {
  it("normalizes 0..1 pointer coordinates against the live browser viewport", async () => {
    const cdp = new FakeCdp();
    const lease = new BrowserLease({ deviceId: "bdv_1", tabId: 7, sessionId: "brs_1" });
    const agent = lease.acquireAgent();
    const human = lease.transferToHuman(agent.epoch);
    const controller = new HumanInputController(cdp);

    await controller.handle(7, lease, message(human.epoch, { input_type: "pointer_move", x: 0.25, y: 0.4, expected_epoch: human.epoch }));

    expect(cdp.calls.at(-1)).toEqual({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 250, y: 200, button: "none" },
    });
  });

  it("rejects human mutation unless the human owns the current epoch", async () => {
    const cdp = new FakeCdp();
    const lease = new BrowserLease({ deviceId: "bdv_1", tabId: 7, sessionId: "brs_1" });
    const agent = lease.acquireAgent();
    const controller = new HumanInputController(cdp);

    await expect(controller.handle(7, lease, message(agent.epoch, { input_type: "click", x: 0.5, y: 0.5, expected_epoch: agent.epoch }))).rejects.toThrow(/owner/i);
    expect(cdp.calls).toEqual([]);
  });

  it("forwards sensitive text locally but returns only redacted audit metadata", async () => {
    const cdp = new FakeCdp();
    const lease = new BrowserLease({ deviceId: "bdv_1", tabId: 7, sessionId: "brs_1" });
    const agent = lease.acquireAgent();
    const human = lease.transferToHuman(agent.epoch);
    const controller = new HumanInputController(cdp);

    const audit = await controller.handle(7, lease, message(human.epoch, {
      input_type: "text_input",
      text: "super-secret-password",
      sensitive: true,
      expected_epoch: human.epoch,
    }));

    expect(cdp.calls.at(-1)).toEqual({ method: "Input.insertText", params: { text: "super-secret-password" } });
    expect(JSON.stringify(audit)).not.toContain("super-secret-password");
    expect(audit).toMatchObject({ type: "text_input", sensitive: true, text: "[REDACTED]" });
  });
});
