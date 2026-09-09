import { redactString } from "../privacy/redaction.js";
import type { DebuggerController } from "./debugger.js";

const MAX_ACTIVITY = 200;
const MAX_TEXT = 2_000;

type FrameTreeResponse = {
  frameTree?: { frame?: { id?: string } };
};

type IsolatedWorldResponse = {
  executionContextId?: number;
};

export type HumanActivityEntry = {
  type: string;
  timestampMs: number;
  target?: string;
  x?: number;
  y?: number;
  key?: string;
  text?: string;
};

export class HumanActivityController {
  private readonly activity: HumanActivityEntry[] = [];
  private readonly bindingName = `cptrAudit_${crypto.randomUUID().replace(/-/g, "")}`;
  private tabId: number | null = null;
  private executionContextId: number | null = null;
  private humanControl = false;
  private installGeneration = 0;
  private inputTransitionTail: Promise<void> = Promise.resolve();

  constructor(private readonly debuggerController: DebuggerController) {
    this.debuggerController.onEvent((tabId, method, params) => {
      if (tabId !== this.tabId) return;
      if (method === "Runtime.bindingCalled") this.onBinding(params as Record<string, unknown>);
      if (method === "Page.frameNavigated") {
        this.executionContextId = null;
        const generation = ++this.installGeneration;
        queueMicrotask(() => {
          if (generation !== this.installGeneration || this.tabId !== tabId) return;
          void this.install(tabId).catch(() => undefined);
        });
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    this.tabId = tabId;
    this.activity.length = 0;
    await this.debuggerController.send(tabId, "Page.enable", {});
    await this.debuggerController.send(tabId, "Runtime.enable", {});
    await this.install(tabId);
    await this.setHumanControl(false);
  }

  async setHumanControl(enabled: boolean): Promise<void> {
    await this.serializeInputTransition(async () => {
      const tabId = this.tabId;
      if (tabId === null) return;
      this.humanControl = enabled;
      await this.debuggerController.send(tabId, "Input.setIgnoreInputEvents", { ignore: !enabled });
      const contextId = await this.ensureInstalled(tabId);
      const mode = enabled ? "human" : "agent";
      await this.debuggerController.send(tabId, "Runtime.evaluate", {
        contextId,
        expression: `(() => { globalThis.__CPTR_AUDIT_MODE__=${JSON.stringify(mode)}; const cursor=document.querySelector('[data-cptr-agent-cursor]'); if(cursor instanceof HTMLElement) cursor.style.display=${JSON.stringify(enabled ? "none" : "block")}; })();`,
        awaitPromise: false,
        returnByValue: true,
      });
    });
  }

  async freezeHumanControlForReturn(): Promise<void> {
    await this.serializeInputTransition(async () => {
      const tabId = this.tabId;
      if (tabId === null || !this.debuggerController.isAttached(tabId)) {
        throw new Error("Dedicated browser human control is unavailable");
      }
      if (!this.humanControl) throw new Error("Human return freeze requires human browser ownership");
      await this.debuggerController.send(tabId, "Input.setIgnoreInputEvents", { ignore: true });
    });
  }

  async resumeHumanControlAfterRejectedReturn(): Promise<void> {
    await this.serializeInputTransition(async () => {
      const tabId = this.tabId;
      if (tabId === null || !this.debuggerController.isAttached(tabId) || !this.humanControl) return;
      await this.debuggerController.send(tabId, "Input.setIgnoreInputEvents", { ignore: false });
    });
  }

  async withAgentInput<T>(operation: () => Promise<T>): Promise<T> {
    return await this.serializeInputTransition(async () => {
      const tabId = this.tabId;
      if (tabId === null || !this.debuggerController.isAttached(tabId)) {
        throw new Error("Dedicated browser agent input is unavailable");
      }
      if (this.humanControl) throw new Error("Agent input is blocked while the human owns the browser lease");

      // Chromium's Input.setIgnoreInputEvents blocks DevTools-dispatched input too.
      // Unlock only around this serialized, lease-authorized agent operation, then
      // fail closed by restoring the native-input block before another transition.
      await this.debuggerController.send(tabId, "Input.setIgnoreInputEvents", { ignore: false });
      try {
        return await operation();
      } finally {
        if (this.tabId === tabId && this.debuggerController.isAttached(tabId)) {
          await this.debuggerController.send(tabId, "Input.setIgnoreInputEvents", { ignore: true });
        }
      }
    });
  }

  list(): HumanActivityEntry[] {
    return this.activity.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.activity.length = 0;
  }

  async detach(): Promise<void> {
    const tabId = this.tabId;
    this.installGeneration += 1;
    this.executionContextId = null;
    this.tabId = null;
    this.humanControl = false;
    if (tabId !== null && this.debuggerController.isAttached(tabId)) {
      await this.debuggerController.send(tabId, "Input.setIgnoreInputEvents", { ignore: false });
    }
  }

  private async serializeInputTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.inputTransitionTail;
    let release!: () => void;
    this.inputTransitionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureInstalled(tabId: number): Promise<number> {
    if (this.executionContextId !== null) return this.executionContextId;
    const contextId = await this.install(tabId);
    if (contextId === null) throw new Error("Dedicated browser audit world is unavailable");
    return contextId;
  }

  private async install(tabId: number): Promise<number | null> {
    if (this.tabId !== tabId || !this.debuggerController.isAttached(tabId)) return null;
    const frameTree = await this.debuggerController.send(tabId, "Page.getFrameTree", {}) as FrameTreeResponse;
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) throw new Error("Dedicated browser main frame is unavailable");
    const isolated = await this.debuggerController.send(tabId, "Page.createIsolatedWorld", {
      frameId,
      worldName: "cptr-dedicated-browser-audit",
      grantUniveralAccess: false,
    }) as IsolatedWorldResponse;
    const contextId = isolated.executionContextId;
    if (!Number.isSafeInteger(contextId)) throw new Error("Dedicated browser isolated world is unavailable");
    this.executionContextId = contextId as number;
    await this.debuggerController.send(tabId, "Runtime.addBinding", {
      name: this.bindingName,
      executionContextId: contextId,
    });
    await this.debuggerController.send(tabId, "Runtime.evaluate", {
      contextId,
      expression: this.bootstrapExpression(),
      awaitPromise: false,
      returnByValue: true,
    });
    return contextId as number;
  }

  private onBinding(params: Record<string, unknown>): void {
    if (params.name !== this.bindingName || typeof params.payload !== "string") return;
    try {
      const decoded = JSON.parse(params.payload) as Record<string, unknown>;
      const type = typeof decoded.type === "string" ? decoded.type.slice(0, 64) : "";
      if (!type) return;
      const entry: HumanActivityEntry = {
        type,
        timestampMs: typeof decoded.timestampMs === "number" ? Math.floor(decoded.timestampMs) : Date.now(),
      };
      if (typeof decoded.target === "string" && decoded.target) entry.target = redactString(decoded.target).slice(0, 256);
      if (typeof decoded.x === "number" && Number.isFinite(decoded.x)) entry.x = Math.max(0, Math.min(1, decoded.x));
      if (typeof decoded.y === "number" && Number.isFinite(decoded.y)) entry.y = Math.max(0, Math.min(1, decoded.y));
      if (typeof decoded.key === "string" && decoded.key) entry.key = decoded.key.slice(0, 128);
      if (typeof decoded.text === "string") entry.text = redactString(decoded.text).slice(0, MAX_TEXT);
      this.activity.push(entry);
      if (this.activity.length > MAX_ACTIVITY) this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
    } catch {
      // Ignore malformed isolated-world audit events. They never grant authority.
    }
  }

  private bootstrapExpression(): string {
    const binding = JSON.stringify(this.bindingName);
    const initialMode = JSON.stringify(this.humanControl ? "human" : "agent");
    return `(() => {
      const bindingName = ${binding};
      const send = (value) => {
        const fn = globalThis[bindingName];
        if (typeof fn !== 'function') return;
        try { fn(JSON.stringify(value)); } catch {}
      };
      globalThis.__CPTR_AUDIT_MODE__ = ${initialMode};
      if (globalThis.__CPTR_AUDIT_INSTALLED__) return true;
      globalThis.__CPTR_AUDIT_INSTALLED__ = true;
      const sensitive = /password|passwd|secret|token|credential|authorization|api[-_ ]?key|one[-_ ]?time|otp/i;
      const targetName = (target) => {
        if (!(target instanceof Element)) return '';
        const role = target.getAttribute('role') || '';
        const aria = target.getAttribute('aria-label') || '';
        const name = target.getAttribute('name') || target.id || '';
        return [target.tagName.toLowerCase(), role, aria, name].filter(Boolean).join(':').slice(0, 256);
      };
      const inputText = (target) => {
        if (!(target instanceof Element)) return undefined;
        const descriptor = [target.getAttribute('name'), target.id, target.getAttribute('autocomplete'), target.getAttribute('aria-label')].filter(Boolean).join(' ');
        if (sensitive.test(descriptor)) return '[REDACTED]';
        if (target instanceof HTMLInputElement) {
          if (target.type === 'password' || sensitive.test(target.type)) return '[REDACTED]';
          if (!['text','search','email','url','tel'].includes(target.type)) return undefined;
          return target.value.slice(0, ${MAX_TEXT});
        }
        if (target instanceof HTMLTextAreaElement) return target.value.slice(0, ${MAX_TEXT});
        if (target instanceof HTMLElement && target.isContentEditable) return (target.innerText || '').slice(0, ${MAX_TEXT});
        return undefined;
      };
      const emit = (type, event, extra = {}) => {
        if (globalThis.__CPTR_AUDIT_MODE__ !== 'human') return;
        const width = Math.max(1, innerWidth || document.documentElement?.clientWidth || 1);
        const height = Math.max(1, innerHeight || document.documentElement?.clientHeight || 1);
        const payload = { type, timestampMs: Date.now(), target: targetName(event.target), ...extra };
        if (typeof event.clientX === 'number') payload.x = Math.max(0, Math.min(1, event.clientX / width));
        if (typeof event.clientY === 'number') payload.y = Math.max(0, Math.min(1, event.clientY / height));
        send(payload);
      };
      let lastMove = 0;
      document.addEventListener('pointermove', (event) => {
        const now = performance.now();
        if (now - lastMove < 100) return;
        lastMove = now;
        emit('pointer_move', event);
      }, true);
      for (const type of ['pointerdown','pointerup','click','dblclick','wheel']) {
        document.addEventListener(type, (event) => emit(type, event), true);
      }
      document.addEventListener('keydown', (event) => emit('key_down', event, { key: String(event.key || '').slice(0, 128) }), true);
      for (const type of ['input','change']) {
        document.addEventListener(type, (event) => {
          const text = inputText(event.target);
          emit(type, event, text === undefined ? {} : { text });
        }, true);
      }
      const cursor = document.createElement('div');
      cursor.setAttribute('data-cptr-agent-cursor', 'true');
      Object.assign(cursor.style, {
        position: 'fixed', width: '18px', height: '18px', border: '2px solid white', borderRadius: '999px',
        background: 'rgba(30, 105, 255, .85)', boxShadow: '0 1px 8px rgba(0,0,0,.45)', pointerEvents: 'none',
        zIndex: '2147483647', transform: 'translate(-50%,-50%)', left: '-40px', top: '-40px'
      });
      const mountCursor = () => { if (!cursor.isConnected && document.documentElement) document.documentElement.appendChild(cursor); };
      mountCursor();
      document.addEventListener('mousemove', (event) => {
        mountCursor();
        cursor.style.display = globalThis.__CPTR_AUDIT_MODE__ === 'agent' ? 'block' : 'none';
        cursor.style.left = event.clientX + 'px';
        cursor.style.top = event.clientY + 'px';
      }, true);
      return true;
    })()`;
  }
}
