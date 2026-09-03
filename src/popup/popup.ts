export {};

type RuntimeResponse<T> = { ok: true; result: T } | { ok: false; error: string };
type DeviceStatus = { paired: boolean; deviceId?: string; deviceName?: string; cptrOrigin?: string };

function requiredElement(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`CPTR popup UI is missing ${selector}`);
  return element;
}

const stateEl = requiredElement("#state") as HTMLElement;
const detailEl = requiredElement("#detail") as HTMLElement;
const optionsButton = requiredElement("#open-options") as HTMLButtonElement;

async function refresh(): Promise<void> {
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
    detailEl.textContent = "Open setup to connect this Chrome profile to CPTR.";
  } catch (error) {
    stateEl.textContent = "Unavailable";
    stateEl.dataset.kind = "error";
    detailEl.textContent = error instanceof Error ? error.message : "Unable to read CPTR device status.";
  }
}

optionsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());
void refresh();
