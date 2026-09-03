import { describe, expect, it } from "vitest";
import { EvaluationController } from "../src/browser/evaluate.js";

describe("approval-gated evaluate", () => {
  it("requires an approval token and returns only bounded redacted by-value data", async () => {
    const calls: Array<{ method: string; params: object }> = [];
    const cdp = {
      async send(_tabId: number, method: string, params: object = {}): Promise<object> {
        calls.push({ method, params });
        return { result: { type: "object", value: { authorization: "Bearer abc.def", title: "Example" } } };
      },
    };
    const evaluation = new EvaluationController(cdp);

    await expect(evaluation.evaluate(7, "document.title", "")).rejects.toThrow(/approval/i);
    expect(calls).toHaveLength(0);

    const result = await evaluation.evaluate(7, "document.title", "approval_1");
    expect(calls[0]?.method).toBe("Runtime.evaluate");
    expect(calls[0]?.params).toMatchObject({
      expression: "document.title",
      awaitPromise: true,
      returnByValue: true,
      generatePreview: false,
      userGesture: false,
      includeCommandLineAPI: false,
      silent: true,
    });
    expect(result).toEqual({ value: { authorization: "[REDACTED]", title: "Example" }, truncated: false });
  });

  it("rejects remote object handles so caller cannot retain page capabilities", async () => {
    const cdp = { async send(): Promise<object> { return { result: { type: "object", objectId: "remote_1" } }; } };
    const evaluation = new EvaluationController(cdp);
    await expect(evaluation.evaluate(7, "window", "approval_1")).rejects.toThrow(/serializable/i);
  });
});
