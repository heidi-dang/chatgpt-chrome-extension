import { z } from "zod";
import type { StorageAreaLike } from "./device-state.js";

const LEGACY_STORAGE_KEY = "cptr.browserSession.v1";
const STORAGE_KEY = "cptr.browserSessions.v2";

const browserSessionStateSchema = z.object({
  deviceId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  tabId: z.number().int().nonnegative(),
  mode: z.enum(["OBSERVING", "AGENT_CONTROL", "HANDOFF_REQUIRED", "HUMAN_CONTROL"]),
  owner: z.enum(["none", "agent", "human"]),
  epoch: z.number().int().nonnegative(),
  snapshotId: z.string().min(1).max(200).nullable(),
}).strict();

const browserSessionCollectionSchema = z.record(z.string().min(1).max(200), browserSessionStateSchema);

export type BrowserSessionState = z.infer<typeof browserSessionStateSchema>;

type BrowserSessionCollection = z.infer<typeof browserSessionCollectionSchema>;

export class BrowserSessionStateRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StorageAreaLike) {}

  async load(sessionId?: string): Promise<BrowserSessionState | null> {
    await this.writeQueue;
    const sessions = await this.readCollection();
    if (sessionId) return sessions[sessionId] ?? null;
    return Object.values(sessions)[0] ?? null;
  }

  async loadAll(): Promise<BrowserSessionState[]> {
    await this.writeQueue;
    return Object.values(await this.readCollection());
  }

  async save(value: BrowserSessionState): Promise<void> {
    const parsed = browserSessionStateSchema.parse(value);
    await this.enqueueWrite(async () => {
      const sessions = await this.readCollection();
      sessions[parsed.sessionId] = parsed;
      await this.storage.set({ [STORAGE_KEY]: browserSessionCollectionSchema.parse(sessions) });
      await this.storage.remove(LEGACY_STORAGE_KEY);
    });
  }

  async clear(sessionId?: string): Promise<void> {
    await this.enqueueWrite(async () => {
      if (!sessionId) {
        await this.storage.remove(STORAGE_KEY);
        await this.storage.remove(LEGACY_STORAGE_KEY);
        return;
      }
      const sessions = await this.readCollection();
      const remaining = Object.fromEntries(
        Object.entries(sessions).filter(([candidateSessionId]) => candidateSessionId !== sessionId),
      );
      if (Object.keys(remaining).length === 0) {
        await this.storage.remove(STORAGE_KEY);
      } else {
        await this.storage.set({ [STORAGE_KEY]: browserSessionCollectionSchema.parse(remaining) });
      }
      const legacy = await this.readLegacy();
      if (legacy?.sessionId === sessionId) await this.storage.remove(LEGACY_STORAGE_KEY);
    });
  }

  private async readCollection(): Promise<BrowserSessionCollection> {
    const record = await this.storage.get(STORAGE_KEY);
    const parsed = browserSessionCollectionSchema.safeParse(record[STORAGE_KEY]);
    const sessions: BrowserSessionCollection = parsed.success ? { ...parsed.data } : {};
    const legacy = await this.readLegacy();
    if (legacy && !sessions[legacy.sessionId]) sessions[legacy.sessionId] = legacy;
    return sessions;
  }

  private async readLegacy(): Promise<BrowserSessionState | null> {
    const record = await this.storage.get(LEGACY_STORAGE_KEY);
    const value = record[LEGACY_STORAGE_KEY];
    if (value === undefined) return null;
    const parsed = browserSessionStateSchema.safeParse(value);
    if (!parsed.success) {
      await this.storage.remove(LEGACY_STORAGE_KEY);
      return null;
    }
    return parsed.data;
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.catch(() => undefined);
    await queued;
  }
}
