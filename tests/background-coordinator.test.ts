import { describe, expect, it, vi } from "vitest";
import { ExtensionCoordinator } from "../src/background/coordinator.js";
import { DeviceStateRepository, type StorageAreaLike } from "../src/state/device-state.js";
import { PendingPairingRepository } from "../src/state/pairing-state.js";

class MemoryStorage implements StorageAreaLike {
  readonly values: Record<string, unknown> = {};
  async get(key: string): Promise<Record<string, unknown>> { return { [key]: this.values[key] }; }
  async set(items: Record<string, unknown>): Promise<void> { Object.assign(this.values, items); }
  async remove(key: string): Promise<void> { Reflect.deleteProperty(this.values, key); }
}

const claimSecret = "claim-secret-0123456789abcdef0123456789abcdef";
const deviceCredential = "device-secret-0123456789abcdef0123456789abcdef";

describe("MV3 background coordinator", () => {
  it("persists pending pairing state without exposing its claim secret to the options UI", async () => {
    const deviceState = new DeviceStateRepository(new MemoryStorage());
    const pairingState = new PendingPairingRepository(new MemoryStorage());
    const pairingClient = {
      request: vi.fn(async () => ({ pairingId: "pair_1", code: "123456", claimSecret, expiresAt: Date.now() + 60_000 })),
      claim: vi.fn(),
    };
    const transport = { start: vi.fn(async () => true), stop: vi.fn() };
    const coordinator = new ExtensionCoordinator({ deviceState, pairingState, pairingClientFactory: () => pairingClient, transport });

    const visible = await coordinator.requestPairing("https://cptr.example.com", "Heidi Chrome");

    expect(visible).toMatchObject({ pairingId: "pair_1", code: "123456" });
    expect(JSON.stringify(visible)).not.toContain(claimSecret);
    expect(await pairingState.load()).toMatchObject({ pairingId: "pair_1", claimSecret });
  });

  it("claims with the hidden secret, stores only the device credential, and starts transport", async () => {
    const deviceState = new DeviceStateRepository(new MemoryStorage());
    const pairingState = new PendingPairingRepository(new MemoryStorage());
    await pairingState.save({
      cptrOrigin: "https://cptr.example.com",
      deviceName: "Heidi Chrome",
      pairingId: "pair_1",
      claimSecret,
      expiresAt: Date.now() + 60_000,
    });
    const pairingClient = {
      request: vi.fn(),
      claim: vi.fn(async () => ({ deviceId: "bdv_1", deviceCredential })),
    };
    const transport = { start: vi.fn(async () => true), stop: vi.fn() };
    const coordinator = new ExtensionCoordinator({ deviceState, pairingState, pairingClientFactory: () => pairingClient, transport });

    const result = await coordinator.claimPairing("pair_1");

    expect(pairingClient.claim).toHaveBeenCalledWith("pair_1", claimSecret);
    expect(result).toEqual({ paired: true, deviceId: "bdv_1", deviceName: "Heidi Chrome", cptrOrigin: "https://cptr.example.com" });
    expect(JSON.stringify(result)).not.toContain(deviceCredential);
    expect(await deviceState.load()).toMatchObject({ deviceId: "bdv_1", deviceCredential, resumeSequence: 0 });
    expect(await pairingState.load()).toBeNull();
    expect(transport.start).toHaveBeenCalledOnce();
  });
});
