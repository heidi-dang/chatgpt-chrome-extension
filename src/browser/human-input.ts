import { redactInputEvent } from "../privacy/redaction.js";
import type { BrowserLease } from "../sessions/leases.js";
import type { HumanInputMessage } from "../transport/protocol.js";
import type { CdpSender } from "./snapshot.js";

interface ViewportMetrics {
  cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
}

interface Point {
  x: number;
  y: number;
}

function modifierBits(modifiers: HumanInputMessage["payload"]["modifiers"]): number {
  let bits = 0;
  for (const modifier of modifiers ?? []) {
    if (modifier === "Alt") bits |= 1;
    else if (modifier === "Control") bits |= 2;
    else if (modifier === "Meta") bits |= 4;
    else bits |= 8;
  }
  return bits;
}

export class HumanInputController {
  constructor(private readonly cdp: CdpSender) {}

  async handle(tabId: number, lease: BrowserLease, message: HumanInputMessage): Promise<Record<string, unknown>> {
    const payload = message.payload;
    lease.assertMutation("human", payload.expected_epoch);
    const audit: Record<string, unknown> = { type: payload.input_type, sensitive: Boolean(payload.sensitive) };

    switch (payload.input_type) {
      case "pointer_move": {
        const point = await this.point(tabId, payload.x, payload.y);
        await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
        return audit;
      }
      case "pointer_down": {
        const point = await this.point(tabId, payload.x, payload.y);
        await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: payload.button ?? "left",
          clickCount: 1,
          modifiers: modifierBits(payload.modifiers),
        });
        return audit;
      }
      case "pointer_up": {
        const point = await this.point(tabId, payload.x, payload.y);
        await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...point,
          button: payload.button ?? "left",
          clickCount: 1,
          modifiers: modifierBits(payload.modifiers),
        });
        return audit;
      }
      case "click":
      case "double_click": {
        const point = await this.point(tabId, payload.x, payload.y);
        const clickCount = payload.input_type === "double_click" ? 2 : 1;
        const button = payload.button ?? "left";
        const modifiers = modifierBits(payload.modifiers);
        await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, clickCount, modifiers });
        await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, clickCount, modifiers });
        return audit;
      }
      case "wheel": {
        const point = await this.point(tabId, payload.x ?? 0.5, payload.y ?? 0.5);
        await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...point,
          deltaX: payload.delta_x ?? 0,
          deltaY: payload.delta_y ?? 0,
          modifiers: modifierBits(payload.modifiers),
        });
        return audit;
      }
      case "key_down":
      case "key_up": {
        if (!payload.key) throw new Error("Human key input requires a key");
        await this.cdp.send(tabId, "Input.dispatchKeyEvent", {
          type: payload.input_type === "key_down" ? "rawKeyDown" : "keyUp",
          key: payload.key,
          code: payload.code ?? payload.key,
          modifiers: modifierBits(payload.modifiers),
        });
        return audit;
      }
      case "text_input": {
        const text = payload.text ?? "";
        await this.cdp.send(tabId, "Input.insertText", { text });
        return { ...redactInputEvent({
          type: "text_input",
          text,
          sensitive: Boolean(payload.sensitive),
        }) };
      }
      case "touch_start":
      case "touch_move":
      case "touch_end": {
        const type = payload.input_type === "touch_start"
          ? "touchStart"
          : payload.input_type === "touch_move"
            ? "touchMove"
            : "touchEnd";
        const touchPoints = type === "touchEnd"
          ? []
          : [{ ...(await this.point(tabId, payload.x, payload.y)), id: payload.pointer_id ?? 0 }];
        await this.cdp.send(tabId, "Input.dispatchTouchEvent", { type, touchPoints, modifiers: modifierBits(payload.modifiers) });
        return audit;
      }
      case "drag_start":
      case "drag_move":
      case "drag_end": {
        const point = await this.point(tabId, payload.x, payload.y);
        const type = payload.input_type === "drag_start"
          ? "mousePressed"
          : payload.input_type === "drag_end"
            ? "mouseReleased"
            : "mouseMoved";
        await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          buttons: payload.input_type === "drag_end" ? 0 : 1,
          clickCount: 1,
        });
        return audit;
      }
      case "focus":
      case "blur":
      case "viewport_resize":
        return audit;
    }
  }

  private async point(tabId: number, x: number | undefined, y: number | undefined): Promise<Point> {
    if (x === undefined || y === undefined) throw new Error("Pointer input requires normalized x and y coordinates");
    if (x < 0 || x > 1 || y < 0 || y > 1) throw new Error("Pointer coordinates must be normalized between 0 and 1");
    const metrics = await this.cdp.send(tabId, "Page.getLayoutMetrics", {}) as ViewportMetrics;
    const width = metrics.cssVisualViewport?.clientWidth;
    const height = metrics.cssVisualViewport?.clientHeight;
    if (!width || !height || width <= 0 || height <= 0) throw new Error("Live Chrome viewport metrics are unavailable");
    return { x: x * width, y: y * height };
  }
}
