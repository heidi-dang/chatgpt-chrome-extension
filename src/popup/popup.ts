export {};

type RuntimeResponse<T> = { ok: true; result: T } | { ok: false; error: string };
type DeviceStatus = { paired: boolean; deviceId?: string; deviceName?: string; cptrOrigin?: string };
type BrowserControlStatus = {
  active?: boolean;
  session_id?: string | null;
  tab_id?: number | null;
  mode?: string;
  owner?: "none" | "agent" | "human";
  epoch?: number;
  url?: string;
  audit?: {
    human_activity?: unknown[];
    console?: unknown[];
    network?: unknown[];
  };
};

function requiredElement(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`CPTR popup UI is missing ${selector}`);
  return element;
}

const stateEl = requiredElement("#state") as HTMLElement;
const detailEl = requiredElement("#detail") as HTMLElement;
const optionsButton = requiredElement("#open-options") as HTMLButtonElement;
const browserPanel = requiredElement("#browser-control") as HTMLElement;
const browserOwner = requiredElement("#browser-owner") as HTMLElement;
const browserDetail = requiredElement("#browser-detail") as HTMLElement;
const browserAudit = requiredElement("#browser-audit") as HTMLElement;
const browserAction = requiredElement("#browser-control-action") as HTMLButtonElement;

let currentOwner = "none";
let controlBusy = false;

async function readDeviceStatus(): Promise<void> {
  try {
    const response: RuntimeResponse<DeviceStatus> = await chrome.runtime.sendMessage({ type: "device.status" });
    if (!response.ok) throw new Error(response.error);
    if (response.result.paired) {
      stateEl.textContent = "Paired";
      stateEl.dataset.kind = "ok";
      detailEl.textContent = `${response.result.deviceName ?? "Chrome"}\n${response.result.cptrOrigin ?? ""}`.trim();
      return;
    }
    stateEl.textContent = "Not paired";
    stateEl.dataset.kind = "";
    detailEl.textContent = "Open setup to connect this Chrome profile to CPTR.";
  } catch (error) {
    stateEl.textContent = "Unavailable";
    stateEl.dataset.kind = "error";
    detailEl.textContent = error instanceof Error ? error.message : "Unable to read CPTR device status.";
  }
}

function renderBrowserControl(status: BrowserControlStatus): void {
  if (!status.active) {
    browserPanel.hidden = true;
    currentOwner = "none";
    return;
  }
  browserPanel.hidden = false;
  currentOwner = status.owner ?? "none";
  const epoch = Number.isSafeInteger(status.epoch) ? status.epoch : 0;
  const mode = status.mode ?? "UNKNOWN";
  const audit = status.audit ?? {};
  browserAudit.textContent = `Audit: ${audit.human_activity?.length ?? 0} human · ${audit.console?.length ?? 0} console · ${audit.network?.length ?? 0} network`;
  browserDetail.textContent = `${mode} · epoch ${epoch}${status.url ? `\n${status.url}` : ""}`;

  if (currentOwner === "agent") {
    browserOwner.textContent = "ChatGPT has control";
    browserAction.textContent = controlBusy ? "Requesting…" : "Take control";
    browserAction.disabled = controlBusy;
  } else if (currentOwner === "human") {
    browserOwner.textContent = "You have control";
    browserAction.textContent = controlBusy ? "Returning…" : "Return to ChatGPT";
    browserAction.disabled = controlBusy;
  } else {
    browserOwner.textContent = "No active controller";
    browserAction.textContent = "Unavailable";
    browserAction.disabled = true;
  }
}

async function readBrowserControl(): Promise<void> {
  try {
    const response: RuntimeResponse<BrowserControlStatus> = await chrome.runtime.sendMessage({ type: "browser.control.status" });
    if (!response.ok) throw new Error(response.error);
    renderBrowserControl(response.result);
  } catch {
    browserPanel.hidden = true;
    currentOwner = "none";
  }
}

async function requestControlChange(): Promise<void> {
  if (controlBusy || (currentOwner !== "agent" && currentOwner !== "human")) return;
  controlBusy = true;
  browserAction.disabled = true;
  browserAction.textContent = currentOwner === "agent" ? "Requesting…" : "Returning…";
  try {
    const type = currentOwner === "agent" ? "browser.control.takeover" : "browser.control.return";
    const response: RuntimeResponse<Record<string, unknown>> = await chrome.runtime.sendMessage({ type });
    if (!response.ok) throw new Error(response.error);
  } catch (error) {
    browserDetail.textContent = error instanceof Error ? error.message : "Browser control request failed.";
  } finally {
    controlBusy = false;
    await readBrowserControl();
  }
}

optionsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());
browserAction.addEventListener("click", () => void requestControlChange());

void Promise.all([readDeviceStatus(), readBrowserControl()]);
const refreshTimer = setInterval(() => void readBrowserControl(), 750);
window.addEventListener("unload", () => clearInterval(refreshTimer), { once: true });
