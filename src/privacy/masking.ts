export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameMasker {
  mask(base64: string, rects: readonly MaskRect[], quality: number): Promise<string>;
}

const MAX_FRAME_BASE64_CHARS = 24 * 1024 * 1024;

function normalizeHostnamePattern(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.includes("/") || normalized.includes(":")) return null;
  return normalized;
}

export class PrivacyCurtainPolicy {
  private readonly patterns: string[];

  constructor(patterns: readonly string[]) {
    this.patterns = patterns
      .map(normalizeHostnamePattern)
      .filter((value): value is string => value !== null)
      .slice(0, 200);
  }

  isProtected(urlValue: string): boolean {
    let hostname: string;
    try {
      const url = new URL(urlValue);
      if (url.protocol !== "http:" && url.protocol !== "https:") return true;
      hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return true;
    }
    return this.patterns.some((pattern) => {
      if (pattern.startsWith("*.")) {
        const suffix = pattern.slice(2);
        return hostname !== suffix && hostname.endsWith(`.${suffix}`);
      }
      return hostname === pattern;
    });
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export class CanvasFrameMasker implements FrameMasker {
  async mask(base64: string, rects: readonly MaskRect[], quality: number): Promise<string> {
    if (base64.length > MAX_FRAME_BASE64_CHARS) throw new Error("Browser frame exceeds masking size limit");
    if (rects.length === 0) return base64;
    const response = await fetch(`data:image/jpeg;base64,${base64}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("OffscreenCanvas 2D context is unavailable");
      context.drawImage(bitmap, 0, 0);
      context.fillStyle = "#000";
      for (const rect of rects.slice(0, 100)) {
        const x = Math.max(0, Math.min(bitmap.width, rect.x));
        const y = Math.max(0, Math.min(bitmap.height, rect.y));
        const width = Math.max(0, Math.min(bitmap.width - x, rect.width));
        const height = Math.max(0, Math.min(bitmap.height - y, rect.height));
        if (width > 0 && height > 0) context.fillRect(x, y, width, height);
      }
      const output = await canvas.convertToBlob({ type: "image/jpeg", quality: Math.min(0.9, Math.max(0.2, quality / 100)) });
      return bytesToBase64(new Uint8Array(await output.arrayBuffer()));
    } finally {
      bitmap.close();
    }
  }
}
