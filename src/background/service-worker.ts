import { ExtensionCoordinator } from "./coordinator.js";
import { chromeLocalStorage, DeviceStateRepository } from "../state/device-state.js";
import { chromeSessionStorage, PendingPairingRepository } from "../state/pairing-state.js";
import { DeviceControlTransport } from "../transport/websocket.js";

const deviceState = new DeviceStateRepository(chromeLocalStorage());
const pairingState = new PendingPairingRepository(chromeSessionStorage());
const transport = new DeviceControlTransport({
  stateRepository: deviceState,
  onMessage: () => undefined,
});
const coordinator = new ExtensionCoordinator({ deviceState, pairingState, transport });

void transport.start();

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
