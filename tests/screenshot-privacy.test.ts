import { describe, expect, it } from "vitest";
import { ScreenshotController } from "../src/browser/screenshot.js";
import { PrivacyCurtainPolicy, type FrameMasker, type MaskRect } from "../src/privacy/masking.js";

class FakeCdp {
  readonly calls: Array<{ method: string; params: object }> = [];
  async send(_tabId: number, method: string, params: object = {}): Promise<object> {
    this.calls.push({ method, params });
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { pageX: 40, pageY: 100, clientWidth: 1280, clientHeight: 720 } };
    }
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

    const result = await screenshots.capture(7, "https://example.com/account", { quality: 65, maxWidth: 640 });

    expect(result).toEqual({
      mimeType: "image/jpeg",
      data: "masked-base64",
      blocked: false,
      maskedRegions: 1,
      width: 640,
      height: 360,
    });
    expect(masker.calls[0]).toEqual({
      base64: "raw-base64",
      rects: [{ x: 2.5, y: 3, width: 50, height: 20 }],
      quality: 65,
    });
    expect(cdp.calls.find((call) => call.method === "Page.captureScreenshot")?.params).toEqual({
      format: "jpeg",
      quality: 65,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 40, y: 100, width: 1280, height: 720, scale: 0.5 },
    });
  });

  it("uses a privacy curtain for configured protected hostnames without capturing the page", async () => {
    const cdp = new FakeCdp();
    const masker = new RecordingMasker();
    const screenshots = new ScreenshotController(cdp, masker, new PrivacyCurtainPolicy(["secure.example.com"]));

    const result = await screenshots.capture(7, "https://secure.example.com/mfa", { quality: 65 });

    expect(result).toEqual({
      mimeType: "image/jpeg",
      data: null,
      blocked: true,
      maskedRegions: 0,
      width: 1280,
      height: 720,
    });
    expect(cdp.calls.map((call) => call.method)).toEqual(["Page.getLayoutMetrics"]);
    expect(masker.calls).toEqual([]);
  });
});
