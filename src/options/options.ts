export {};

type RuntimeResponse<T> = { ok: true; result: T } | { ok: false; error: string };

type PairingResult = {
  pairingId: string;
  expiresAt: number;
};

type DeviceStatus = {
  paired: boolean;
  deviceId?: string;
  deviceName?: string;
  cptrOrigin?: string;
};

function requiredElement(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`CPTR options UI is missing ${selector}`);
  return element;
}

const form = requiredElement("#pair-form") as HTMLFormElement;
const originInput = requiredElement("#cptr-origin") as HTMLInputElement;
const deviceInput = requiredElement("#device-name") as HTMLInputElement;
const statusEl = requiredElement("#status") as HTMLElement;
const pairingEl = requiredElement("#pairing") as HTMLElement;
const pairingIdEl = requiredElement("#pairing-id") as HTMLElement;
const claimButton = requiredElement("#claim-button") as HTMLButtonElement;

function setStatus(message: string, kind: "ok" | "error" | "info" = "info"): void {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

async function runtimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  const response: RuntimeResponse<T> = await chrome.runtime.sendMessage(message);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

function normalizedOrigin(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    throw new Error("Use HTTPS for CPTR (HTTP is allowed only for loopback development).");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("CPTR origin must not contain credentials, query, or fragment.");
  return parsed.origin;
}

async function refreshStatus(): Promise<void> {
  try {
    const device = await runtimeMessage<DeviceStatus>({ type: "device.status" });
    if (device.paired) {
      setStatus(`Paired: ${device.deviceName ?? "Chrome"} · ${device.cptrOrigin ?? "CPTR"}`, "ok");
      if (device.cptrOrigin) originInput.value = device.cptrOrigin;
      if (device.deviceName) deviceInput.value = device.deviceName;
      pairingEl.hidden = true;
      return;
    }
    setStatus("Not paired. Enter your trusted CPTR origin to begin.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to read device status.", "error");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    try {
      const cptrOrigin = normalizedOrigin(originInput.value);
      const deviceName = deviceInput.value.trim() || "Heidi Chrome";
      const permissionOrigin = `${cptrOrigin}/`;
      const granted = await chrome.permissions.request({ origins: [permissionOrigin] });
      if (!granted) throw new Error("Chrome host permission is required for the trusted CPTR origin.");
      setStatus("Requesting secure pairing…");
      const result = await runtimeMessage<PairingResult>({ type: "pairing.request", cptrOrigin, deviceName });
      pairingIdEl.textContent = result.pairingId;
      claimButton.dataset.pairingId = result.pairingId;
      pairingEl.hidden = false;
      setStatus("Approve this exact pairing ID through authenticated CPTR, then click Claim pairing.", "ok");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pairing request failed.", "error");
    }
  })();
});

claimButton.addEventListener("click", () => {
  void (async () => {
    const pairingId = claimButton.dataset.pairingId;
    if (!pairingId) return;
    try {
      setStatus("Claiming approved pairing…");
      const result = await runtimeMessage<DeviceStatus>({ type: "pairing.claim", pairingId });
      setStatus(`Paired successfully: ${result.deviceName ?? "Chrome"}`, "ok");
      pairingEl.hidden = true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pairing claim failed.", "error");
    }
  })();
});

void refreshStatus();
