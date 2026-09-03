import { z } from "zod";

const STORAGE_KEY = "cptr.browserDevice.v1";

const deviceStateSchema = z.object({
  cptrOrigin: z.url(),
  deviceId: z.string().min(1).max(200),
  deviceCredential: z.string().min(32).max(1024),
  deviceName: z.string().min(1).max(120),
  resumeSequence: z.number().int().nonnegative(),
}).strict();

export type DeviceState = z.infer<typeof deviceStateSchema>;

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class DeviceStateRepository {
  constructor(private readonly storage: StorageAreaLike) {}

  async load(): Promise<DeviceState | null> {
    const record = await this.storage.get(STORAGE_KEY);
    const value = record[STORAGE_KEY];
    if (value === undefined) return null;
    const parsed = deviceStateSchema.safeParse(value);
    if (!parsed.success) {
      await this.clear();
      return null;
    }
    return parsed.data;
  }

  async save(state: DeviceState): Promise<void> {
    const value = deviceStateSchema.parse(state);
    await this.storage.set({ [STORAGE_KEY]: value });
  }

  async updateResumeSequence(sequence: number): Promise<void> {
    const current = await this.load();
    if (!current || sequence <= current.resumeSequence) return;
    await this.save({ ...current, resumeSequence: sequence });
  }

  async clear(): Promise<void> {
    await this.storage.remove(STORAGE_KEY);
  }
}

export function chromeLocalStorage(): StorageAreaLike {
  return {
    async get(key) {
      return await chrome.storage.local.get(key);
    },
    async set(items) {
      await chrome.storage.local.set(items);
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    },
  };
}
