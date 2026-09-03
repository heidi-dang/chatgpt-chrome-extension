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

export interface ScreenshotResult {
  mimeType: "image/jpeg";
  data: string | null;
  blocked: boolean;
  maskedRegions: number;
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

  async capture(tabId: number, url: string, options: { quality?: number } = {}): Promise<ScreenshotResult> {
    if (this.curtain.isProtected(url)) {
      return { mimeType: "image/jpeg", data: null, blocked: true, maskedRegions: 0 };
    }
    const quality = Math.min(90, Math.max(20, Math.round(options.quality ?? 65)));
    const masks = await this.findSensitiveRegions(tabId);
    const response = await this.cdp.send(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality,
      fromSurface: true,
      captureBeyondViewport: false,
    }) as ScreenshotResponse;
    if (!response.data) throw new Error("Chrome returned an empty screenshot");
    const data = masks.length > 0 ? await this.masker.mask(response.data, masks, quality) : response.data;
    return {
      mimeType: "image/jpeg",
      data,
      blocked: false,
      maskedRegions: masks.length,
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
