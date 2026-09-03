export type LeaseOwner = "none" | "agent" | "human";

export type BrowserLeaseSnapshot = {
  deviceId: string;
  tabId: number;
  sessionId: string;
  owner: LeaseOwner;
  epoch: number;
  snapshotId: string | null;
};

export class LeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseError";
  }
}

export class BrowserLease {
  readonly deviceId: string;
  readonly tabId: number;
  readonly sessionId: string;
  private currentOwner: LeaseOwner = "none";
  private currentEpoch = 0;
  private currentSnapshotId: string | null = null;
  private preHumanSnapshotId: string | null = null;

  constructor(input: { deviceId: string; tabId: number; sessionId: string }) {
    this.deviceId = input.deviceId;
    this.tabId = input.tabId;
    this.sessionId = input.sessionId;
  }

  get owner(): LeaseOwner {
    return this.currentOwner;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  acquireAgent(snapshotId?: string): BrowserLeaseSnapshot {
    return this.bootstrapAgent(this.currentEpoch + 1, snapshotId);
  }

  bootstrapAgent(authoritativeEpoch: number, snapshotId?: string): BrowserLeaseSnapshot {
    if (this.currentOwner !== "none") {
      throw new LeaseError(`Cannot acquire agent lease while owner is ${this.currentOwner}`);
    }
    if (!Number.isSafeInteger(authoritativeEpoch) || authoritativeEpoch <= this.currentEpoch) {
      throw new LeaseError(`Authoritative lease epoch must be greater than ${this.currentEpoch}`);
    }
    this.currentOwner = "agent";
    this.currentEpoch = authoritativeEpoch;
    this.currentSnapshotId = snapshotId ?? null;
    return this.snapshot();
  }

  transferToHuman(expectedEpoch: number): BrowserLeaseSnapshot {
    this.assertMutation("agent", expectedEpoch);
    this.preHumanSnapshotId = this.currentSnapshotId;
    this.currentOwner = "human";
    this.currentEpoch += 1;
    return this.snapshot();
  }

  returnToAgent(expectedEpoch: number, freshSnapshotId: string): BrowserLeaseSnapshot {
    this.assertMutation("human", expectedEpoch);
    if (!freshSnapshotId || freshSnapshotId === this.preHumanSnapshotId) {
      throw new LeaseError("A fresh snapshot is required before returning control to the agent");
    }
    this.currentSnapshotId = freshSnapshotId;
    this.preHumanSnapshotId = null;
    this.currentOwner = "agent";
    this.currentEpoch += 1;
    return this.snapshot();
  }

  release(expectedEpoch: number): BrowserLeaseSnapshot {
    if (expectedEpoch !== this.currentEpoch) {
      throw new LeaseError(`Lease epoch mismatch: expected ${this.currentEpoch}, received ${expectedEpoch}`);
    }
    this.currentOwner = "none";
    this.currentEpoch += 1;
    this.currentSnapshotId = null;
    this.preHumanSnapshotId = null;
    return this.snapshot();
  }

  assertMutation(actor: Exclude<LeaseOwner, "none">, expectedEpoch: number): void {
    if (expectedEpoch !== this.currentEpoch) {
      throw new LeaseError(`Lease epoch mismatch: expected ${this.currentEpoch}, received ${expectedEpoch}`);
    }
    if (this.currentOwner !== actor) {
      throw new LeaseError(`Lease owner mismatch: ${actor} cannot mutate while owner is ${this.currentOwner}`);
    }
  }

  snapshot(): BrowserLeaseSnapshot {
    return {
      deviceId: this.deviceId,
      tabId: this.tabId,
      sessionId: this.sessionId,
      owner: this.currentOwner,
      epoch: this.currentEpoch,
      snapshotId: this.currentSnapshotId,
    };
  }
}
