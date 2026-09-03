import { ExtensionCoordinator } from "./coordinator.js";
import { chromeLocalStorage, DeviceStateRepository } from "../state/device-state.js";
import { chromeSessionStorage, PendingPairingRepository } from "../state/pairing-state.js";
import { BrowserSessionStateRepository } from "../state/browser-session-state.js";
import { DeviceControlTransport } from "../transport/websocket.js";
import { DeviceVisualTransport } from "../transport/visual-websocket.js";
import { BrowserSessionRuntime, type BrowserHandoffMessage, type BrowserPrepareReturnMessage } from "./browser-session-runtime.js";

const deviceState = new DeviceStateRepository(chromeLocalStorage());
const sessionStorage = chromeSessionStorage();
const pairingState = new PendingPairingRepository(sessionStorage);
const browserSessionState = new BrowserSessionStateRepository(sessionStorage);
const isHandoffMessage = (message: { type: string }): message is BrowserHandoffMessage =>
  message.type === "browser.handoff.accepted" ||
  message.type === "browser.handoff.returned" ||
  message.type === "browser.handoff.cancelled";
const isPrepareReturnMessage = (message: { type: string }): message is BrowserPrepareReturnMessage =>
  message.type === "browser.handoff.prepare_return";

const visualTransport = new DeviceVisualTransport({ stateRepository: deviceState });
const browserRuntime = new BrowserSessionRuntime(visualTransport, browserSessionState);
const transport = new DeviceControlTransport({
  stateRepository: deviceState,
  onMessage: (message) => {
    if (message.type === "browser.command") {
      void browserRuntime.handle(message).then((result) => {
        transport.send({
          protocol_version: 1,
          type: result.type,
          device_id: message.device_id,
          session_id: message.session_id,
          surface_id: message.surface_id,
          sequence: message.sequence,
          timestamp: new Date().toISOString(),
          source: "extension",
          mode: message.mode,
          command_id: result.commandId,
          payload: result.payload,
        });
      });
      return;
    }
    if (message.type === "browser.stream.configure") {
      browserRuntime.configureStream(message);
      return;
    }
    if (message.type === "browser.human.input") {
      void browserRuntime.handleHumanInput(message).then((result) => {
        transport.send({
          protocol_version: 1,
          type: result.type,
          device_id: message.device_id,
          session_id: message.session_id,
          surface_id: message.surface_id,
          sequence: message.sequence,
          timestamp: new Date().toISOString(),
          source: "extension",
          mode: "HUMAN_CONTROL",
          command_id: result.commandId,
          payload: result.payload,
        });
      });
      return;
    }
    if (isPrepareReturnMessage(message)) {
      void browserRuntime.prepareReturn(message).then((result) => {
        transport.send({
          protocol_version: 1,
          type: result.type,
          device_id: message.device_id,
          session_id: message.session_id,
          surface_id: message.surface_id,
          sequence: message.sequence,
          timestamp: new Date().toISOString(),
          source: "extension",
          mode: "HUMAN_CONTROL",
          command_id: result.commandId,
          payload: result.payload,
        });
      });
      return;
    }
    if (isHandoffMessage(message)) void browserRuntime.syncHandoff(message);
  },
});
const coordinator = new ExtensionCoordinator({ deviceState, pairingState, transport });

void browserRuntime.restore().finally(() => {
  void Promise.all([transport.start(), visualTransport.start()]);
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";

  if (type === "pairing.request") {
    const cptrOrigin = typeof record.cptrOrigin === "string" ? record.cptrOrigin : "";
    const deviceName = typeof record.deviceName === "string" ? record.deviceName : "";
    void coordinator.requestPairing(cptrOrigin, deviceName)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Pairing request failed" }));
    return true;
  }

  if (type === "pairing.claim") {
    const pairingId = typeof record.pairingId === "string" ? record.pairingId : "";
    void coordinator.claimPairing(pairingId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Pairing claim failed" }));
    return true;
  }

  if (type === "device.status") {
    void deviceState.load()
      .then((state) => sendResponse({
        ok: true,
        result: state
          ? { paired: true, deviceId: state.deviceId, deviceName: state.deviceName, cptrOrigin: state.cptrOrigin }
          : { paired: false },
      }))
      .catch(() => sendResponse({ ok: false, error: "Device status unavailable" }));
    return true;
  }

  return false;
});
