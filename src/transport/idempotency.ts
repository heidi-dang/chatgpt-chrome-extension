export class BoundedCommandDedupe {
  private readonly ids = new Map<string, true>();
  private readonly limit: number;

  constructor(limit = 512) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Command dedupe limit must be positive");
    this.limit = limit;
  }

  markIfNew(commandId: string): boolean {
    if (!commandId) throw new Error("commandId is required");
    if (this.ids.has(commandId)) return false;
    this.ids.set(commandId, true);
    while (this.ids.size > this.limit) {
      const oldest = this.ids.keys().next().value;
      if (typeof oldest !== "string") break;
      this.ids.delete(oldest);
    }
    return true;
  }

  has(commandId: string): boolean {
    return this.ids.has(commandId);
  }

  get size(): number {
    return this.ids.size;
  }

  clear(): void {
    this.ids.clear();
  }
}
