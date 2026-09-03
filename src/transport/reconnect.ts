export type ReconnectPolicyOptions = {
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  random?: () => number;
};

export class ReconnectPolicy {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;

  constructor(options: ReconnectPolicyOptions = {}) {
    this.baseMs = Math.max(100, options.baseMs ?? 500);
    this.maxMs = Math.max(this.baseMs, options.maxMs ?? 30_000);
    this.jitterRatio = Math.min(0.5, Math.max(0, options.jitterRatio ?? 0.2));
    this.random = options.random ?? Math.random;
  }

  delayMs(attempt: number): number {
    const normalizedAttempt = Math.max(0, Math.min(30, Math.trunc(attempt)));
    const exponential = Math.min(this.maxMs, this.baseMs * 2 ** normalizedAttempt);
    const randomCentered = this.random() * 2 - 1;
    const jitter = exponential * this.jitterRatio * randomCentered;
    return Math.round(Math.min(this.maxMs, Math.max(this.baseMs, exponential + jitter)));
  }
}

export class SequenceCursor {
  private lastAccepted = 0;

  accept(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
    if (sequence <= this.lastAccepted) return false;
    this.lastAccepted = sequence;
    return true;
  }

  get resumeFrom(): number {
    return this.lastAccepted;
  }

  reset(sequence = 0): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid sequence cursor");
    this.lastAccepted = sequence;
  }
}
