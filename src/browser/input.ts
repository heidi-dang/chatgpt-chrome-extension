import type { SnapshotRefs } from "./snapshot-refs.js";
import type { CdpSender } from "./snapshot.js";

type Point = { x: number; y: number };
type BoxModelResponse = { model?: { content?: number[]; border?: number[] } };
type ResolveNodeResponse = { object?: { objectId?: string } };

function centerOfQuad(values: number[] | undefined): Point {
  if (!values || values.length < 8) throw new Error("Element has no interactable box model");
  const xs = [values[0], values[2], values[4], values[6]].filter((value): value is number => typeof value === "number");
  const ys = [values[1], values[3], values[5], values[7]].filter((value): value is number => typeof value === "number");
  if (xs.length !== 4 || ys.length !== 4) throw new Error("Element box model is malformed");
  return {
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
  };
}

export class BrowserInputController {
  private readonly pointerByTab = new Map<number, Point>();
  private readonly pointCache = new Map<string, Point>();

  constructor(
    private readonly cdp: CdpSender,
    private readonly refs: SnapshotRefs,
    private readonly motionDelayMs = 4,
  ) {}

  async pointForRef(tabId: number, ref: string, snapshotId: string): Promise<Point> {
    const cacheKey = `${tabId}:${snapshotId}:${ref}`;
    const cached = this.pointCache.get(cacheKey);
    if (cached) return cached;
    const node = this.refs.resolve(ref, snapshotId);
    const response = await this.cdp.send(tabId, "DOM.getBoxModel", { backendNodeId: node.backendNodeId }) as BoxModelResponse;
    const point = centerOfQuad(response.model?.content ?? response.model?.border);
    this.pointCache.set(cacheKey, point);
    if (this.pointCache.size > 512) this.pointCache.delete(this.pointCache.keys().next().value as string);
    return point;
  }

  async click(tabId: number, ref: string, snapshotId: string, options: { button?: "left" | "right"; clickCount?: number } = {}): Promise<void> {
    const point = await this.pointForRef(tabId, ref, snapshotId);
    await this.movePointer(tabId, point);
    const { x, y } = point;
    const button = options.button ?? "left";
    const clickCount = Math.min(2, Math.max(1, options.clickCount ?? 1));
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
  }

  async hover(tabId: number, ref: string, snapshotId: string): Promise<void> {
    await this.movePointer(tabId, await this.pointForRef(tabId, ref, snapshotId));
  }

  async focus(tabId: number, ref: string, snapshotId: string): Promise<void> {
    const node = this.refs.resolve(ref, snapshotId);
    await this.cdp.send(tabId, "DOM.focus", { backendNodeId: node.backendNodeId });
  }

  async fill(tabId: number, ref: string, snapshotId: string, text: string): Promise<void> {
    await this.clear(tabId, ref, snapshotId);
    await this.cdp.send(tabId, "Input.insertText", { text });
  }

  async clear(tabId: number, ref: string, snapshotId: string): Promise<void> {
    await this.focus(tabId, ref, snapshotId);
    await this.dispatchKey(tabId, "rawKeyDown", "a", "KeyA", 2);
    await this.dispatchKey(tabId, "keyUp", "a", "KeyA", 2);
    await this.dispatchKey(tabId, "rawKeyDown", "Backspace", "Backspace", 0);
    await this.dispatchKey(tabId, "keyUp", "Backspace", "Backspace", 0);
  }

  async type(tabId: number, ref: string, snapshotId: string, text: string): Promise<void> {
    await this.focus(tabId, ref, snapshotId);
    await this.cdp.send(tabId, "Input.insertText", { text });
  }

  async pressKey(tabId: number, key: string, code = key, modifiers = 0): Promise<void> {
    await this.dispatchKey(tabId, "rawKeyDown", key, code, modifiers);
    await this.dispatchKey(tabId, "keyUp", key, code, modifiers);
  }

  async keyDown(tabId: number, key: string, code = key, modifiers = 0): Promise<void> {
    await this.dispatchKey(tabId, "rawKeyDown", key, code, modifiers);
  }

  async keyUp(tabId: number, key: string, code = key, modifiers = 0): Promise<void> {
    await this.dispatchKey(tabId, "keyUp", key, code, modifiers);
  }

  async scroll(tabId: number, deltaX: number, deltaY: number, x = 1, y = 1): Promise<void> {
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  async drag(tabId: number, sourceRef: string, targetRef: string, snapshotId: string): Promise<void> {
    const source = await this.pointForRef(tabId, sourceRef, snapshotId);
    const target = await this.pointForRef(tabId, targetRef, snapshotId);
    await this.movePointer(tabId, source);
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...source, button: "left", clickCount: 1 });
    await this.movePointer(tabId, target, { button: "left", buttons: 1 });
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...target, button: "left", clickCount: 1 });
  }

  async selectOption(tabId: number, ref: string, snapshotId: string, value: string): Promise<void> {
    const objectId = await this.resolveObjectId(tabId, ref, snapshotId);
    await this.cdp.send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(value){if(!(this instanceof HTMLSelectElement))throw new Error('Target is not a select');const option=[...this.options].find((item)=>item.value===value||item.label===value||item.text===value);if(!option)throw new Error('Option not found');this.value=option.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}",
      arguments: [{ value }],
      awaitPromise: false,
      returnByValue: true,
    });
  }

  async setChecked(tabId: number, ref: string, snapshotId: string, checked: boolean): Promise<void> {
    const objectId = await this.resolveObjectId(tabId, ref, snapshotId);
    await this.cdp.send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(checked){if(!(this instanceof HTMLInputElement)||(this.type!=='checkbox'&&this.type!=='radio'))throw new Error('Target is not checkable');if(this.checked===checked)return;this.checked=checked;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}",
      arguments: [{ value: checked }],
      awaitPromise: false,
      returnByValue: true,
    });
  }

  private async movePointer(
    tabId: number,
    target: Point,
    buttons: { button?: "none" | "left"; buttons?: number } = {},
  ): Promise<void> {
    const start = this.pointerByTab.get(tabId) ?? {
      x: Math.max(0, target.x - 72),
      y: Math.max(0, target.y - 48),
    };
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    const steps = Math.max(3, Math.min(10, Math.ceil(distance / 80)));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const eased = t * t * (3 - 2 * t);
      const x = start.x + (target.x - start.x) * eased;
      const y = start.y + (target.y - start.y) * eased;
      await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: buttons.button ?? "none",
        ...(buttons.buttons === undefined ? {} : { buttons: buttons.buttons }),
      });
      if (this.motionDelayMs > 0 && step < steps) await this.delay(this.motionDelayMs);
    }
    this.pointerByTab.set(tabId, target);
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private async resolveObjectId(tabId: number, ref: string, snapshotId: string): Promise<string> {
    const node = this.refs.resolve(ref, snapshotId);
    const response = await this.cdp.send(tabId, "DOM.resolveNode", { backendNodeId: node.backendNodeId }) as ResolveNodeResponse;
    const objectId = response.object?.objectId;
    if (!objectId) throw new Error("Referenced DOM node could not be resolved");
    return objectId;
  }

  private async dispatchKey(tabId: number, type: "rawKeyDown" | "keyUp", key: string, code: string, modifiers: number): Promise<void> {
    await this.cdp.send(tabId, "Input.dispatchKeyEvent", { type, key, code, modifiers });
  }
}
