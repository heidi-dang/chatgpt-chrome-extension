import { z } from "zod";
import type { StorageAreaLike } from "./device-state.js";

const STORAGE_KEY = "cptr.pendingPairing.v1";

const pendingPairingSchema = z.object({
  cptrOrigin: z.url(),
  deviceName: z.string().min(1).max(120),
  pairingId: z.string().min(1).max(200),
  claimSecret: z.string().min(32).max(1024),
  expiresAt: z.number().int().positive(),
}).strict();

export type PendingPairing = z.infer<typeof pendingPairingSchema>;

export class PendingPairingRepository {
  constructor(private readonly storage: StorageAreaLike) {}

  async load(): Promise<PendingPairing | null> {
    const record = await this.storage.get(STORAGE_KEY);
    const parsed = pendingPairingSchema.safeParse(record[STORAGE_KEY]);
    if (parsed.success) return parsed.data;
    if (record[STORAGE_KEY] !== undefined) await this.clear();
    return null;
  }

  async save(value: PendingPairing): Promise<void> {
    await this.storage.set({ [STORAGE_KEY]: pendingPairingSchema.parse(value) });
  }

  async clear(): Promise<void> {
    await this.storage.remove(STORAGE_KEY);
  }
}

export function chromeSessionStorage(): StorageAreaLike {
  return {
    async get(key) {
      return await chrome.storage.session.get(key);
    },
    async set(items) {
      await chrome.storage.session.set(items);
    },
    async remove(key) {
      await chrome.storage.session.remove(key);
    },
  };
}
