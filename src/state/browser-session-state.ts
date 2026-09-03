import { z } from "zod";
import type { StorageAreaLike } from "./device-state.js";

const STORAGE_KEY = "cptr.browserSession.v1";

const browserSessionStateSchema = z.object({
  deviceId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  tabId: z.number().int().nonnegative(),
  mode: z.enum(["OBSERVING", "AGENT_CONTROL", "HANDOFF_REQUIRED", "HUMAN_CONTROL"]),
  owner: z.enum(["none", "agent", "human"]),
  epoch: z.number().int().nonnegative(),
  snapshotId: z.string().min(1).max(200).nullable(),
}).strict();

export type BrowserSessionState = z.infer<typeof browserSessionStateSchema>;

export class BrowserSessionStateRepository {
  constructor(private readonly storage: StorageAreaLike) {}

  async load(): Promise<BrowserSessionState | null> {
    const record = await this.storage.get(STORAGE_KEY);
    const value = record[STORAGE_KEY];
    if (value === undefined) return null;
    const parsed = browserSessionStateSchema.safeParse(value);
    if (!parsed.success) {
      await this.clear();
      return null;
    }
    return parsed.data;
  }

  async save(value: BrowserSessionState): Promise<void> {
    await this.storage.set({ [STORAGE_KEY]: browserSessionStateSchema.parse(value) });
  }

  async clear(): Promise<void> {
    await this.storage.remove(STORAGE_KEY);
  }
}
