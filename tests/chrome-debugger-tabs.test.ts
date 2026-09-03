import { describe, expect, it, vi } from "vitest";
import { DebuggerController, UnsupportedCdpCommandError, type DebuggerApiLike } from "../src/browser/debugger.js";
import { DownloadsController, type DownloadsApiLike } from "../src/browser/downloads.js";
import { TabsController, type TabsApiLike } from "../src/browser/tabs.js";
import { WindowsController, type WindowsApiLike } from "../src/browser/windows.js";

describe("chrome.debugger lifecycle", () => {
  it("attaches idempotently and records detach transitions", async () => {
    const detachListeners: Array<(source: chrome.debugger.Debuggee, reason: string) => void> = [];
    const api: DebuggerApiLike = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: (listener) => detachListeners.push(listener) },
    };
    const controller = new DebuggerController(api);

    await controller.attach(12);
    await controller.attach(12);
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(controller.isAttached(12)).toBe(true);

    detachListeners[0]?.({ tabId: 12 }, "target_closed");
    expect(controller.isAttached(12)).toBe(false);
    expect(controller.lastDetachReason(12)).toBe("target_closed");
  });

  it("does not expose arbitrary CDP commands", async () => {
    const api: DebuggerApiLike = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: () => undefined },
    };
    const controller = new DebuggerController(api);
    await controller.attach(1);

    await expect(controller.send(1, "Browser.grantPermissions", {})).rejects.toBeInstanceOf(UnsupportedCdpCommandError);
    expect(api.sendCommand).not.toHaveBeenCalled();
  });
});

describe("download API boundary", () => {
  it("sanitizes download metadata and rejects embedded URL credentials", async () => {
    const api: DownloadsApiLike = {
      download: vi.fn(async () => 11),
      search: vi.fn(async () => [{
        id: 11,
        url: "https://example.com/file?token=secret",
        finalUrl: "https://example.com/file",
        referrer: "",
        filename: "/Users/heidi/Downloads/private.pdf",
        incognito: false,
        danger: "safe" as const,
        mime: "application/pdf",
        startTime: "2026-09-03T00:00:00Z",
        endTime: "2026-09-03T00:00:01Z",
        estimatedEndTime: "",
        state: "complete" as const,
        paused: false,
        canResume: false,
        error: undefined,
        bytesReceived: 10,
        totalBytes: 10,
        fileSize: 10,
        exists: true,
        byExtensionId: undefined,
        byExtensionName: undefined,
      }]),
      cancel: vi.fn(async () => undefined),
    };
    const downloads = new DownloadsController(api);

    expect(await downloads.start("https://example.com/file")).toEqual({ downloadId: 11 });
    expect((await downloads.list())[0]).toMatchObject({
      id: 11,
      url: "https://example.com/file?token=%5BREDACTED%5D",
      filename: "private.pdf",
      state: "complete",
    });
    await downloads.cancel(11);
    expect(api.cancel).toHaveBeenCalledWith(11);
    await expect(downloads.start("https://user:pass@example.com/file")).rejects.toThrow(/credentials/i);
  });
});

describe("window API boundary", () => {
  it("returns bounded safe window metadata, creates, and focuses windows", async () => {
    const api: WindowsApiLike = {
      getAll: vi.fn(async () => [{ id: 3, focused: false, incognito: false, state: "normal", type: "normal", top: 10, left: 20, width: 1200, height: 800 } as chrome.windows.Window]),
      create: vi.fn(async (data) => ({ id: 4, focused: data?.focused ?? false, incognito: false, state: "normal", type: "normal" } as chrome.windows.Window)),
      update: vi.fn(async (id, info) => ({ id, focused: info.focused ?? false, incognito: false, state: "normal", type: "normal" } as chrome.windows.Window)),
    };
    const windows = new WindowsController(api);

    expect(await windows.list()).toEqual([{
      id: 3, focused: false, incognito: false, state: "normal", type: "normal",
      top: 10, left: 20, width: 1200, height: 800,
    }]);
    expect((await windows.create("https://example.com")).id).toBe(4);
    expect(api.create).toHaveBeenCalledWith({ url: "https://example.com", focused: true });
    expect((await windows.focus(3)).focused).toBe(true);
    expect(api.update).toHaveBeenCalledWith(3, { focused: true });
  });
});

describe("tab API boundary", () => {
  it("returns bounded safe tab metadata and activates the selected tab", async () => {
    const api: TabsApiLike = {
      query: vi.fn(async () => [{
        id: 4,
        windowId: 2,
        active: false,
        title: "Example",
        url: "https://example.com/private?token=secret",
        status: "complete",
        pinned: false,
        incognito: false,
      } as chrome.tabs.Tab]),
      get: vi.fn(async (id) => ({ id, windowId: 2, active: false, title: "Example", url: "https://example.com/" } as chrome.tabs.Tab)),
      update: vi.fn(async (id, props) => ({ id, windowId: 2, active: props.active ?? false } as chrome.tabs.Tab)),
      create: vi.fn(async (props) => ({ id: 5, windowId: 2, active: true, url: props.url } as chrome.tabs.Tab)),
      remove: vi.fn(async () => undefined),
      duplicate: vi.fn(async (id) => ({ id: id + 1, windowId: 2, active: false } as chrome.tabs.Tab)),
    };
    const tabs = new TabsController(api);

    expect(await tabs.list()).toEqual([{
      id: 4,
      windowId: 2,
      active: false,
      title: "Example",
      url: "https://example.com/private?token=%5BREDACTED%5D",
      status: "complete",
      pinned: false,
      incognito: false,
    }]);
    await tabs.activate(4);
    expect(api.update).toHaveBeenCalledWith(4, { active: true });
    expect((await tabs.open("https://example.com/new")).id).toBe(5);
    expect(api.create).toHaveBeenCalledWith({ url: "https://example.com/new", active: true });
    expect((await tabs.duplicate(4)).id).toBe(5);
    expect(api.duplicate).toHaveBeenCalledWith(4);
    await tabs.close(4);
    expect(api.remove).toHaveBeenCalledWith(4);
  });

  it("rejects tabs without stable numeric ids", async () => {
    const api = {
      query: vi.fn(async () => [{ windowId: 2, active: true } as chrome.tabs.Tab]),
      get: vi.fn(), update: vi.fn(), create: vi.fn(), remove: vi.fn(), duplicate: vi.fn(),
    } satisfies TabsApiLike;
    const tabs = new TabsController(api);
    await expect(tabs.list()).rejects.toThrow(/tab id/i);
  });
});
