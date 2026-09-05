import { ExtensionCoordinator } from "./coordinator.js";
import { chromeLocalStorage, DeviceStateRepository } from "../state/device-state.js";
import { chromeSessionStorage, PendingPairingRepository } from "../state/pairing-state.js";
import { BrowserSessionStateRepository } from "../state/browser-session-state.js";
import { DeviceControlTransport, type DeviceConnectionState } from "../transport/websocket.js";
import { DeviceVisualTransport } from "../transport/visual-websocket.js";
import { PROTOCOL_VERSION } from "../transport/protocol.js";
import type { BrowserHandoffMessage, BrowserPrepareReturnMessage } from "./browser-session-runtime.js";
import { BrowserSessionRuntimeRegistry } from "./browser-session-registry.js";

const localStorage = chromeLocalStorage();
const deviceState = new DeviceStateRepository(localStorage);
const sessionStorage = chromeSessionStorage();
const pairingState = new PendingPairingRepository(sessionStorage);
// Browser session/lease metadata contains no credentials, but the CPTR backend
// invalidates every browser lease when the control socket disconnects. Persisted
// rows are therefore cleanup hints only and must never re-authorize debugger control.
const browserSessionState = new BrowserSessionStateRepository(localStorage);
const isHandoffMessage = (message: { type: string }): message is BrowserHandoffMessage =>
  message.type === "browser.handoff.accepted" ||
  message.type === "browser.handoff.returned" ||
  message.type === "browser.handoff.cancelled";
const isPrepareReturnMessage = (message: { type: string }): message is BrowserPrepareReturnMessage =>
  message.type === "browser.handoff.prepare_return";

function diagnosticError(scope: string, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(`[CPTR] ${scope}: ${normalized.name}: ${normalized.message.slice(0, 500)}`);
}

function diagnosticState(state: DeviceConnectionState): void {
  console.info(`[CPTR] control transport state=${state}`);
}

const visualTransport = new DeviceVisualTransport({
  stateRepository: deviceState,
  onError: (error) => diagnosticError("visual transport", error),
});
const browserRuntimes = new BrowserSessionRuntimeRegistry(visualTransport, browserSessionState);
const transport = new DeviceControlTransport({
  stateRepository: deviceState,
  onError: (error) => diagnosticError("control transport", error),
  onState: diagnosticState,
  onDisconnect: async () => {
    await browserRuntimes.closeAll();
  },
  onMessage: (message) => {
    if (message.type === "browser.command") {
      void browserRuntimes.handleCommand(message)
        .then((result) => {
          transport.send({
            protocol_version: PROTOCOL_VERSION,
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
        })
        .catch((error: unknown) => {
          diagnosticError("browser command dispatch", error);
          transport.send({
            protocol_version: PROTOCOL_VERSION,
            type: "browser.command.failed",
            device_id: message.device_id,
            session_id: message.session_id,
            surface_id: message.surface_id,
            sequence: message.sequence,
            timestamp: new Date().toISOString(),
            source: "extension",
            mode: message.mode,
            command_id: message.command_id,
            payload: { error: "Browser command dispatch failed", code: "extension_dispatch_error", retriable: false },
          });
        });
      return;
    }
    if (message.type === "browser.stream.configure") {
      void browserRuntimes.configureStream(message).catch((error: unknown) => diagnosticError("stream configuration", error));
      return;
    }
    if (message.type === "browser.human.input") {
      void browserRuntimes.handleHumanInput(message)
        .then((result) => {
          transport.send({
            protocol_version: PROTOCOL_VERSION,
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
        })
        .catch((error: unknown) => diagnosticError("human input dispatch", error));
      return;
    }
    if (isPrepareReturnMessage(message)) {
      void browserRuntimes.prepareReturn(message)
        .then((result) => {
          transport.send({
            protocol_version: PROTOCOL_VERSION,
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
        })
        .catch((error: unknown) => diagnosticError("handoff preparation", error));
      return;
    }
    if (isHandoffMessage(message)) {
      void browserRuntimes.syncHandoff(message).catch((error: unknown) => diagnosticError("handoff synchronization", error));
      return;
    }
    if (message.type === "browser.session.stop") {
      void browserRuntimes.stopSession(message.session_id).catch((error: unknown) => diagnosticError("session stop", error));
    }
  },
});
const coordinator = new ExtensionCoordinator({ deviceState, pairingState, transport });

void browserRuntimes.discardPersisted()
  .catch((error: unknown) => diagnosticError("session cleanup", error))
  .finally(() => {
    void Promise.all([transport.start(), visualTransport.start()]).catch((error: unknown) => diagnosticError("transport startup", error));
  });

// MV3 service workers are event-driven and are not guaranteed to run merely
// because Chrome launched. Register an explicit startup listener so Chrome
// wakes this worker after every browser restart; the module-level startup above
// then restores the persisted device state and reconnects both transports.
chrome.runtime.onStartup.addListener(() => undefined);

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
