export type SnapshotNodeRef = {
  backendNodeId: number;
  objectId?: string;
  nodeId?: number;
};

export class StaleRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRefError";
  }
}

export class SnapshotRefs {
  private snapshotId: string | null = null;
  private refs = new Map<string, SnapshotNodeRef>();

  replace(snapshotId: string, refs: ReadonlyMap<string, SnapshotNodeRef>): void {
    if (!snapshotId) throw new Error("snapshotId is required");
    this.snapshotId = snapshotId;
    this.refs = new Map(refs);
  }

  invalidate(): void {
    this.snapshotId = null;
    this.refs.clear();
  }

  resolve(ref: string, snapshotId: string): SnapshotNodeRef {
    if (!this.snapshotId || snapshotId !== this.snapshotId) {
      throw new StaleRefError(`Stale element ref ${ref}: snapshot ${snapshotId} is no longer current`);
    }
    const value = this.refs.get(ref);
    if (!value) throw new StaleRefError(`Unknown or stale element ref ${ref}`);
    return value;
  }

  get currentSnapshotId(): string | null {
    return this.snapshotId;
  }
}
