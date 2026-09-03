import { describe, expect, it } from "vitest";
import { ScreenshotController } from "../src/browser/screenshot.js";
import { PrivacyCurtainPolicy, type FrameMasker, type MaskRect } from "../src/privacy/masking.js";

class FakeCdp {
  readonly calls: Array<{ method: string; params: object }> = [];
  async send(_tabId: number, method: string, params: object = {}): Promise<object> {
    this.calls.push({ method, params });
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [10] };
    if (method === "DOM.getBoxModel") return { model: { border: [5, 6, 105, 6, 105, 46, 5, 46] } };
    if (method === "Page.captureScreenshot") return { data: "raw-base64" };
    return {};
  }
}

class RecordingMasker implements FrameMasker {
  readonly calls: Array<{ base64: string; rects: MaskRect[]; quality: number }> = [];
  async mask(base64: string, rects: readonly MaskRect[], quality: number): Promise<string> {
    this.calls.push({ base64, rects: [...rects], quality });
    return "masked-base64";
  }
}

describe("screenshot privacy boundary", () => {
  it("masks sensitive input regions before a frame leaves the extension", async () => {
    const cdp = new FakeCdp();
    const masker = new RecordingMasker();
    const screenshots = new ScreenshotController(cdp, masker, new PrivacyCurtainPolicy([]));

    const result = await screenshots.capture(7, "https://example.com/account", { quality: 65 });

    expect(result).toEqual({ mimeType: "image/jpeg", data: "masked-base64", blocked: false, maskedRegions: 1 });
    expect(masker.calls[0]?.rects).toEqual([{ x: 5, y: 6, width: 100, height: 40 }]);
    expect(cdp.calls.map((call) => call.method)).toContain("Page.captureScreenshot");
  });

  it("uses a privacy curtain for configured protected hostnames without capturing the page", async () => {
    const cdp = new FakeCdp();
    const masker = new RecordingMasker();
    const screenshots = new ScreenshotController(cdp, masker, new PrivacyCurtainPolicy(["secure.example.com"]));

    const result = await screenshots.capture(7, "https://secure.example.com/mfa", { quality: 65 });

    expect(result).toEqual({ mimeType: "image/jpeg", data: null, blocked: true, maskedRegions: 0 });
    expect(cdp.calls).toEqual([]);
    expect(masker.calls).toEqual([]);
  });
});
