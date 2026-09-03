import { z } from "zod";

const pairingResponseSchema = z.object({
  pairing_id: z.string().min(1).max(200),
  code: z.string().regex(/^\d{6}$/),
  claim_secret: z.string().min(32).max(1024),
  expires_at: z.number().int().positive(),
}).strict();

const claimResponseSchema = z.object({
  status: z.literal("claimed"),
  device_id: z.string().min(1).max(200),
  device_credential: z.string().min(32).max(1024),
}).strict();

export type PairingRequest = {
  pairingId: string;
  code: string;
  claimSecret: string;
  expiresAt: number;
};

export type ClaimedDevice = {
  deviceId: string;
  deviceCredential: string;
};

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function normalizeCptrOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CPTR URL must be a valid absolute URL");
  }
  if (url.username || url.password) throw new Error("CPTR URL must not contain embedded credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("CPTR device pairing requires HTTPS except for explicit loopback development origins");
  }
  if (url.search || url.hash) throw new Error("CPTR URL must not contain query parameters or fragments");
  return url.origin;
}

async function parseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw new Error(`CPTR pairing request failed (${response.status})`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("CPTR pairing response must be JSON");
  return schema.parse(await response.json());
}

export class PairingClient {
  private readonly origin: string;

  constructor(origin: string, private readonly fetcher: typeof fetch = fetch) {
    this.origin = normalizeCptrOrigin(origin);
  }

  async request(deviceName: string): Promise<PairingRequest> {
    const name = deviceName.trim();
    if (!name || name.length > 120) throw new Error("Device name must be between 1 and 120 characters");
    const response = await this.fetcher(`${this.origin}/api/browser-device/v1/pairing/request`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      body: JSON.stringify({ device_name: name }),
    });
    const value = await parseJson(response, pairingResponseSchema);
    return {
      pairingId: value.pairing_id,
      code: value.code,
      claimSecret: value.claim_secret,
      expiresAt: value.expires_at,
    };
  }

  async claim(pairingId: string, claimSecret: string): Promise<ClaimedDevice> {
    const response = await this.fetcher(`${this.origin}/api/browser-device/v1/pairing/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      body: JSON.stringify({ pairing_id: pairingId, claim_secret: claimSecret }),
    });
    const value = await parseJson(response, claimResponseSchema);
    return { deviceId: value.device_id, deviceCredential: value.device_credential };
  }
}
