import type { CdpSender } from "./snapshot.js";
import { redactForTransport } from "../privacy/redaction.js";

const MAX_EXPRESSION_CHARS = 20_000;
const MAX_RESULT_JSON_CHARS = 40_000;

type RuntimeEvaluateResponse = {
  result?: {
    type?: string;
    value?: unknown;
    description?: string;
    objectId?: string;
  };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

export class EvaluationController {
  constructor(private readonly cdp: CdpSender) {}

  async evaluate(tabId: number, expression: string, approvalToken: string): Promise<Record<string, unknown>> {
    if (!expression || expression.length > MAX_EXPRESSION_CHARS) throw new Error("evaluate expression must be between 1 and 20000 characters");
    if (!approvalToken || approvalToken.length > 512) throw new Error("evaluate requires a valid approval token");
    const response = await this.cdp.send(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      generatePreview: false,
      userGesture: false,
      includeCommandLineAPI: false,
      silent: true,
    }) as RuntimeEvaluateResponse;
    if (response.exceptionDetails) {
      const message = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Evaluation failed";
      throw new Error(message.slice(0, 4_000));
    }
    if (response.result?.objectId) throw new Error("Evaluate result must be serializable by value");
    const safe = redactForTransport(response.result?.value ?? response.result?.description ?? null);
    const encoded = JSON.stringify(safe);
    if (encoded.length > MAX_RESULT_JSON_CHARS) {
      return { value: encoded.slice(0, MAX_RESULT_JSON_CHARS), truncated: true };
    }
    return { value: safe, truncated: false };
  }
}
