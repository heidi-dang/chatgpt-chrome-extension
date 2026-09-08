import type { FrameMasker, MaskRect, PrivacyCurtainPolicy } from "../privacy/masking.js";
import type { CdpSender } from "./snapshot.js";

const SENSITIVE_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="password" i]',
  'input[name*="passcode" i]',
  'input[name*="otp" i]',
  'input[name*="verification" i]',
  'input[name*="cvv" i]',
  'input[name*="cvc" i]',
  'input[name*="pin" i]',
].join(",");

interface DocumentResponse { root?: { nodeId?: number } }
interface QueryResponse { nodeIds?: number[] }
interface BoxResponse { model?: { border?: number[]; content?: number[] } }
interface ScreenshotResponse { data?: string }
interface ViewportMetrics {
  pageX?: number;
  pageY?: number;
  clientWidth?: number;
  clientHeight?: number;
}

interface LayoutMetricsResponse {
  cssVisualViewport?: ViewportMetrics;
  cssLayoutViewport?: ViewportMetrics;
  layoutViewport?: ViewportMetrics;
}

export interface ScreenshotResult {
  mimeType: "image/jpeg";
  data: string | null;
  blocked: boolean;
  maskedRegions: number;
  width: number;
  height: number;
}

function rectFromQuad(quad: number[] | undefined): MaskRect | null {
  if (!quad || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]].filter((value): value is number => typeof value === "number");
  const ys = [quad[1], quad[3], quad[5], quad[7]].filter((value): value is number => typeof value === "number");
  if (xs.length !== 4 || ys.length !== 4) return null;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX <= minX || maxY <= minY) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export class ScreenshotController {
  constructor(
    private readonly cdp: CdpSender,
    private readonly masker: FrameMasker,
    private readonly curtain: PrivacyCurtainPolicy,
  ) {}

  async capture(
    tabId: number,
    url: string,
    options: { quality?: number; maxWidth?: number } = {},
  ): Promise<ScreenshotResult> {
    const viewport = await this.viewportSize(tabId);
    const { width, height } = viewport;
    if (this.curtain.isProtected(url)) {
      return { mimeType: "image/jpeg", data: null, blocked: true, maskedRegions: 0, width, height };
    }

    const quality = Math.min(90, Math.max(20, Math.round(options.quality ?? 65)));
    let maxWidth: number | null = null;
    if (options.maxWidth !== undefined) {
      if (!Number.isFinite(options.maxWidth) || options.maxWidth <= 0) {
        throw new Error("Screenshot maxWidth must be a positive finite number");
      }
      maxWidth = Math.max(1, Math.round(options.maxWidth));
    }
    const scale = maxWidth !== null && width > maxWidth ? maxWidth / width : 1;
    const outputWidth = Math.max(1, Math.round(width * scale));
    const outputHeight = Math.max(1, Math.round(height * scale));

    const masks = await this.findSensitiveRegions(tabId);
    const captureParams: Record<string, unknown> = {
      format: "jpeg",
      quality,
      fromSurface: true,
      captureBeyondViewport: false,
    };
    if (scale < 1) {
      captureParams.clip = {
        x: viewport.x,
        y: viewport.y,
        width,
        height,
        scale,
      };
    }
    const response = await this.cdp.send(tabId, "Page.captureScreenshot", captureParams) as ScreenshotResponse;
    if (!response.data) throw new Error("Chrome returned an empty screenshot");

    const outputMasks = scale < 1
      ? masks.map((rect) => ({
          x: rect.x * scale,
          y: rect.y * scale,
          width: rect.width * scale,
          height: rect.height * scale,
        }))
      : masks;
    const data = outputMasks.length > 0
      ? await this.masker.mask(response.data, outputMasks, quality)
      : response.data;
    return {
      mimeType: "image/jpeg",
      data,
      blocked: false,
      maskedRegions: masks.length,
      width: outputWidth,
      height: outputHeight,
    };
  }

  private async viewportSize(
    tabId: number,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const metrics = await this.cdp.send(tabId, "Page.getLayoutMetrics", {}) as LayoutMetricsResponse;
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport;
    const width = viewport?.clientWidth;
    const height = viewport?.clientHeight;
    if (
      typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
      typeof height !== "number" || !Number.isFinite(height) || height <= 0
    ) {
      throw new Error("Chrome did not report a valid viewport size");
    }
    const pageX = viewport?.pageX;
    const pageY = viewport?.pageY;
    return {
      x: typeof pageX === "number" && Number.isFinite(pageX) ? pageX : 0,
      y: typeof pageY === "number" && Number.isFinite(pageY) ? pageY : 0,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  }

  private async findSensitiveRegions(tabId: number): Promise<MaskRect[]> {
    const document = await this.cdp.send(tabId, "DOM.getDocument", { depth: 1, pierce: true }) as DocumentResponse;
    const nodeId = document.root?.nodeId;
    if (!Number.isSafeInteger(nodeId)) return [];
    const query = await this.cdp.send(tabId, "DOM.querySelectorAll", { nodeId, selector: SENSITIVE_SELECTOR }) as QueryResponse;
    const masks: MaskRect[] = [];
    for (const sensitiveNodeId of (query.nodeIds ?? []).slice(0, 50)) {
      if (!Number.isSafeInteger(sensitiveNodeId)) continue;
      try {
        const box = await this.cdp.send(tabId, "DOM.getBoxModel", { nodeId: sensitiveNodeId }) as BoxResponse;
        const rect = rectFromQuad(box.model?.border ?? box.model?.content);
        if (rect) masks.push(rect);
      } catch {
        // Nodes can disappear between discovery and box lookup. A missing region is not fatal.
      }
    }
    return masks;
  }
}
