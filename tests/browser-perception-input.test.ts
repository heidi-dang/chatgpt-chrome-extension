import { describe, expect, it } from "vitest";
import { AccessibilitySnapshotController } from "../src/browser/snapshot.js";
import { BrowserInputController } from "../src/browser/input.js";
import { NavigationController } from "../src/browser/navigation.js";
import { SnapshotRefs } from "../src/browser/snapshot-refs.js";

type CdpCall = { tabId: number; method: string; params: object };

class FakeCdp {
  readonly calls: CdpCall[] = [];
  async send(tabId: number, method: string, params: object = {}): Promise<object> {
    this.calls.push({ tabId, method, params });
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          { backendDOMNodeId: 18, role: { value: "button" }, name: { value: "Sign in" } },
          { backendDOMNodeId: 19, role: { value: "textbox" }, name: { value: "Password" }, value: { value: "hunter2" } },
          { backendDOMNodeId: 20, role: { value: "StaticText" }, name: { value: "Welcome" } },
        ],
      };
    }
    if (method === "DOM.getBoxModel") {
      return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } };
    }
    if (method === "Page.getNavigationHistory") {
      return {
        currentIndex: 1,
        entries: [{ id: 4, url: "https://example.com/a" }, { id: 5, url: "https://example.com/b" }],
      };
    }
    return {};
  }
}

describe("accessibility-first perception", () => {
  it("produces snapshot-scoped refs and suppresses sensitive field values", async () => {
    const cdp = new FakeCdp();
    const refs = new SnapshotRefs();
    const snapshotter = new AccessibilitySnapshotController(cdp, refs, () => "snap_1");

    const result = await snapshotter.capture(7);

    expect(result.snapshotId).toBe("snap_1");
    expect(result.text).toContain('[ref=ref_1] button "Sign in"');
    expect(result.text).toContain('[ref=ref_2] textbox "Password"');
    expect(result.text).not.toContain("hunter2");
    expect(refs.resolve("ref_1", "snap_1")).toEqual({ backendNodeId: 18 });
  });
});

describe("ref-based input", () => {
  it("supports bounded key down/up and ref-to-ref drag without arbitrary evaluation", async () => {
    const cdp = new FakeCdp();
    const refs = new SnapshotRefs();
    refs.replace("snap_1", new Map([
      ["ref_source", { backendNodeId: 18 }],
      ["ref_target", { backendNodeId: 20 }],
    ]));
    const input = new BrowserInputController(cdp, refs);

    await input.keyDown(7, "Shift", "ShiftLeft");
    await input.keyUp(7, "Shift", "ShiftLeft");
    await input.drag(7, "ref_source", "ref_target", "snap_1");

    expect(cdp.calls[0]).toEqual({ tabId: 7, method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", modifiers: 0 } });
    expect(cdp.calls[1]).toEqual({ tabId: 7, method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Shift", code: "ShiftLeft", modifiers: 0 } });
    expect(cdp.calls.filter((call) => call.method === "DOM.getBoxModel")).toHaveLength(2);
    expect(cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params)).toEqual([
      { type: "mouseMoved", x: 60, y: 40, button: "none" },
      { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 },
      { type: "mouseMoved", x: 60, y: 40, button: "left", buttons: 1 },
      { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 },
    ]);
  });

  it("clicks the center of the referenced DOM box without screenshot coordinates", async () => {
    const cdp = new FakeCdp();
    const refs = new SnapshotRefs();
    refs.replace("snap_1", new Map([["ref_18", { backendNodeId: 18 }]]));
    const input = new BrowserInputController(cdp, refs);

    await input.click(7, "ref_18", "snap_1");

    expect(cdp.calls).toContainEqual({ tabId: 7, method: "DOM.getBoxModel", params: { backendNodeId: 18 } });
    expect(cdp.calls).toContainEqual({
      tabId: 7,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 },
    });
    expect(cdp.calls).toContainEqual({
      tabId: 7,
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 },
    });
  });

  it("fills a ref using focus + key events + insertText instead of arbitrary page evaluation", async () => {
    const cdp = new FakeCdp();
    const refs = new SnapshotRefs();
    refs.replace("snap_1", new Map([["ref_18", { backendNodeId: 18 }]]));
    const input = new BrowserInputController(cdp, refs);

    await input.fill(7, "ref_18", "snap_1", "hello");

    expect(cdp.calls.map((call) => call.method)).toEqual([
      "DOM.focus",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.insertText",
    ]);
    expect(cdp.calls.at(-1)?.params).toEqual({ text: "hello" });
  });
});

describe("navigation policy", () => {
  it("rejects embedded URL credentials before invoking CDP", async () => {
    const cdp = new FakeCdp();
    const navigation = new NavigationController(cdp);
    await expect(navigation.navigate(7, "https://user:pass@example.com/")).rejects.toThrow(/credentials/i);
    expect(cdp.calls).toEqual([]);
  });

  it("navigates back using the current CDP navigation history", async () => {
    const cdp = new FakeCdp();
    const navigation = new NavigationController(cdp);
    await navigation.back(7);
    expect(cdp.calls.at(-1)).toEqual({ tabId: 7, method: "Page.navigateToHistoryEntry", params: { entryId: 4 } });
  });
});
