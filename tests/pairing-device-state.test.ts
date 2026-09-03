import { describe, expect, it, vi } from "vitest";
import { DeviceStateRepository, type StorageAreaLike } from "../src/state/device-state.js";
import { BrowserSessionStateRepository } from "../src/state/browser-session-state.js";
import { PairingClient, normalizeCptrOrigin } from "../src/transport/pairing.js";

class MemoryStorage implements StorageAreaLike {
  readonly values: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.values[key] };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }

  async remove(key: string): Promise<void> {
    delete this.values[key];
  }
}

describe("device credential state", () => {
  it("persists only the device-scoped credential and reconnect cursor", async () => {
    const storage = new MemoryStorage();
    const repo = new DeviceStateRepository(storage);
    await repo.save({
      cptrOrigin: "https://cptr.example.com",
      deviceId: "bdv_1",
      deviceCredential: "device-secret-0123456789abcdef0123456789abcdef",
      deviceName: "Heidi Chrome",
      resumeSequence: 830,
    });

    expect(await repo.load()).toMatchObject({ deviceId: "bdv_1", deviceCredential: "device-secret-0123456789abcdef0123456789abcdef", resumeSequence: 830 });
    expect(JSON.stringify(storage.values)).not.toContain("mcp_token");
    expect(JSON.stringify(storage.values)).not.toContain("bearer_token");
  });
});

describe("restart-safe browser session state", () => {
  it("persists only non-secret session/lease metadata", async () => {
    const storage = new MemoryStorage();
    const repo = new BrowserSessionStateRepository(storage);
    await repo.save({
      deviceId: "bdv_1",
      sessionId: "brs_1",
      tabId: 7,
      mode: "HUMAN_CONTROL",
      owner: "human",
      epoch: 22,
      snapshotId: "snap_21",
    });

    expect(await repo.load()).toEqual({
      deviceId: "bdv_1",
      sessionId: "brs_1",
      tabId: 7,
      mode: "HUMAN_CONTROL",
      owner: "human",
      epoch: 22,
      snapshotId: "snap_21",
    });
    const serialized = JSON.stringify(storage.values);
    expect(serialized).not.toMatch(/credential|cookie|password|text|url|authorization/i);
  });

  it("persists multiple browser sessions independently", async () => {
    const storage = new MemoryStorage();
    const repo = new BrowserSessionStateRepository(storage);
    await repo.save({
      deviceId: "bdv_1", sessionId: "brs_github", tabId: 7,
      mode: "AGENT_CONTROL", owner: "agent", epoch: 1, snapshotId: null,
    });
    await repo.save({
      deviceId: "bdv_1", sessionId: "brs_replit", tabId: 8,
      mode: "AGENT_CONTROL", owner: "agent", epoch: 3, snapshotId: "snap_2",
    });

    expect(await repo.load("brs_github")).toMatchObject({ sessionId: "brs_github", tabId: 7, epoch: 1 });
    expect(await repo.load("brs_replit")).toMatchObject({ sessionId: "brs_replit", tabId: 8, epoch: 3 });
    expect((await repo.loadAll()).map((state) => state.sessionId).sort()).toEqual(["brs_github", "brs_replit"]);

    await repo.clear("brs_github");
    expect(await repo.load("brs_github")).toBeNull();
    expect(await repo.load("brs_replit")).toMatchObject({ tabId: 8 });
  });
});

describe("secure pairing client", () => {
  it("binds the default WorkerGlobalScope fetch receiver", async () => {
    const originalFetch = globalThis.fetch;
    const receiver = globalThis;
    const calls: unknown[] = [];
    globalThis.fetch = function (this: typeof globalThis): Promise<Response> {
      calls.push(this);
      return Promise.resolve(new Response(JSON.stringify({
        pairing_id: "pair_bound",
        code: "654321",
        claim_secret: "claim-secret-0123456789abcdef0123456789abcdef",
        expires_at: 2_000_000_000_000,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    };
    try {
      const client = new PairingClient("https://cptr.example.com");
      await client.request("Heidi Chrome");
      expect(calls).toEqual([receiver]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires HTTPS except explicit loopback development origins", () => {
    expect(normalizeCptrOrigin("https://cptr.example.com/path")).toBe("https://cptr.example.com");
    expect(normalizeCptrOrigin("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000");
    expect(() => normalizeCptrOrigin("http://cptr.example.com")).toThrow(/https/i);
    expect(() => normalizeCptrOrigin("https://user:pass@cptr.example.com")).toThrow(/credentials/i);
  });

  it("keeps the claim secret out of URLs and returns a device credential once approved", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pairing_id: "pair_1",
        code: "123456",
        claim_secret: "claim-secret-0123456789abcdef0123456789abcdef",
        expires_at: 2_000_000_000_000,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "claimed",
        device_id: "bdv_1",
        device_credential: "device-secret-0123456789abcdef0123456789abcdef",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new PairingClient("https://cptr.example.com", fetcher);

    const pairing = await client.request("Heidi Chrome");
    const claimed = await client.claim(pairing.pairingId, pairing.claimSecret);

    expect(claimed.deviceId).toBe("bdv_1");
    const claimUrl = String(fetcher.mock.calls[1]?.[0]);
    expect(claimUrl).not.toContain("claim-secret-0123456789abcdef0123456789abcdef");
    const claimBody = String(fetcher.mock.calls[1]?.[1]?.body);
    expect(claimBody).toContain("claim-secret-0123456789abcdef0123456789abcdef");
  });
});
