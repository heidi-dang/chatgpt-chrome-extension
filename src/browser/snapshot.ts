import type { SnapshotNodeRef, SnapshotRefs } from "./snapshot-refs.js";

export interface CdpSender {
  send(tabId: number, method: string, params?: object): Promise<object>;
}

export type AccessibilitySnapshot = {
  snapshotId: string;
  text: string;
  nodeCount: number;
  refCount: number;
  truncated: boolean;
};

type AxValue = { value?: unknown };
type AxNode = {
  backendDOMNodeId?: number;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  ignored?: boolean;
};

type FullAxTreeResponse = { nodes?: AxNode[] };

const MAX_AX_NODES = 1_000;
const MAX_SNAPSHOT_CHARS = 80_000;
const VALUE_REDACTED_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

function stringValue(value: AxValue | undefined, max = 1_000): string {
  const raw = value?.value;
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return "";
  const text = typeof raw === "string" ? raw : String(raw);
  let sanitized = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    sanitized += code < 32 || code === 127 ? " " : char;
  }
  return sanitized.trim().slice(0, max);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

export class AccessibilitySnapshotController {
  constructor(
    private readonly cdp: CdpSender,
    private readonly refs: SnapshotRefs,
    private readonly idFactory: () => string = () => `snap_${crypto.randomUUID()}`,
  ) {}

  async capture(tabId: number): Promise<AccessibilitySnapshot> {
    await this.cdp.send(tabId, "Accessibility.enable", {});
    const response = await this.cdp.send(tabId, "Accessibility.getFullAXTree", {}) as FullAxTreeResponse;
    const nodes = (response.nodes ?? []).slice(0, MAX_AX_NODES);
    const snapshotId = this.idFactory();
    const nextRefs = new Map<string, SnapshotNodeRef>();
    const lines: string[] = [];
    let chars = 0;
    let refIndex = 0;
    let truncated = (response.nodes?.length ?? 0) > nodes.length;

    for (const node of nodes) {
      if (node.ignored) continue;
      const role = stringValue(node.role, 120) || "unknown";
      const name = stringValue(node.name, 2_000);
      const backendNodeId = node.backendDOMNodeId;
      let prefix = "";
      if (Number.isSafeInteger(backendNodeId)) {
        refIndex += 1;
        const ref = `ref_${refIndex}`;
        nextRefs.set(ref, { backendNodeId: backendNodeId as number });
        prefix = `[ref=${ref}] `;
      }
      let line = `${prefix}${role}${name ? ` ${quoted(name)}` : ""}`;
      if (!VALUE_REDACTED_ROLES.has(role.toLowerCase())) {
        const value = stringValue(node.value, 2_000);
        if (value && value !== name) line += ` value=${quoted(value)}`;
      }
      if (chars + line.length + 1 > MAX_SNAPSHOT_CHARS) {
        truncated = true;
        break;
      }
      lines.push(line);
      chars += line.length + 1;
    }

    this.refs.replace(snapshotId, nextRefs);
    return {
      snapshotId,
      text: lines.join("\n"),
      nodeCount: nodes.length,
      refCount: nextRefs.size,
      truncated,
    };
  }
}
