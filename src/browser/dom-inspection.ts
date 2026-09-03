import type { CdpSender } from "./snapshot.js";
import type { SnapshotRefs } from "./snapshot-refs.js";
import { redactString } from "../privacy/redaction.js";

const MAX_TEXT_CHARS = 40_000;
const MAX_HTML_CHARS = 80_000;
const MAX_ATTRIBUTE_CHARS = 8_000;
const SENSITIVE_ATTRIBUTE = /^(?:value|password|passwd|token|secret|credential|authorization|cookie|data-(?:token|secret|credential))$/i;

type DescribeNodeResponse = {
  node?: {
    nodeName?: string;
    nodeValue?: string;
    attributes?: string[];
  };
};

type OuterHtmlResponse = { outerHTML?: string };

function bounded(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: value.slice(0, max), truncated: true };
}

function attributesFromFlatList(items: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const safeItems = (items ?? []).slice(0, 400);
  for (let index = 0; index + 1 < safeItems.length; index += 2) {
    const name = safeItems[index];
    const raw = safeItems[index + 1];
    if (!name || raw === undefined) continue;
    result[name] = SENSITIVE_ATTRIBUTE.test(name)
      ? "[REDACTED]"
      : bounded(redactString(raw), MAX_ATTRIBUTE_CHARS).value;
  }
  return result;
}

export class DomInspectionController {
  constructor(private readonly cdp: CdpSender, private readonly refs: SnapshotRefs) {}

  async getHtml(tabId: number, ref: string, snapshotId: string): Promise<{ html: string; truncated: boolean }> {
    const node = this.refs.resolve(ref, snapshotId);
    const response = await this.cdp.send(tabId, "DOM.getOuterHTML", { backendNodeId: node.backendNodeId }) as OuterHtmlResponse;
    const result = bounded(redactString(response.outerHTML ?? ""), MAX_HTML_CHARS);
    return { html: result.value, truncated: result.truncated };
  }

  async getText(tabId: number, ref: string, snapshotId: string): Promise<{ text: string; truncated: boolean }> {
    const node = this.refs.resolve(ref, snapshotId);
    const response = await this.cdp.send(tabId, "DOM.describeNode", { backendNodeId: node.backendNodeId, depth: 0, pierce: false }) as DescribeNodeResponse;
    const result = bounded(redactString(response.node?.nodeValue ?? ""), MAX_TEXT_CHARS);
    return { text: result.value, truncated: result.truncated };
  }

  async getAttribute(tabId: number, ref: string, snapshotId: string, name: string): Promise<{ name: string; value: string | null }> {
    const node = this.refs.resolve(ref, snapshotId);
    const response = await this.cdp.send(tabId, "DOM.describeNode", { backendNodeId: node.backendNodeId, depth: 0, pierce: false }) as DescribeNodeResponse;
    const attributes = attributesFromFlatList(response.node?.attributes);
    if (SENSITIVE_ATTRIBUTE.test(name)) return { name, value: "[REDACTED]" };
    return { name, value: Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] ?? null : null };
  }
}

export function findInSnapshot(snapshotText: string, query: string, maxResults = 50): Array<{ line: number; text: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("find requires a non-empty query");
  const results: Array<{ line: number; text: string }> = [];
  const lines = snapshotText.split("\n");
  for (let index = 0; index < lines.length && results.length < Math.max(1, Math.min(maxResults, 50)); index += 1) {
    const line = lines[index] ?? "";
    if (line.toLowerCase().includes(needle)) results.push({ line: index + 1, text: line.slice(0, 2_000) });
  }
  return results;
}
