const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passwd|credential|api[_-]?key|access[_-]?key|refresh[_-]?token|session[_-]?id)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactString(value: string): string {
  return value.replace(BEARER, "Bearer [REDACTED]");
}

export function redactForTransport(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactForTransport(item, depth + 1));
  if (value && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      safe[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactForTransport(item, depth + 1);
    }
    return safe;
  }
  if (value === undefined) return "[UNDEFINED]";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return `[symbol:${value.description ?? ""}]`;
  if (typeof value === "function") return "[FUNCTION]";
  return "[UNSUPPORTED]";
}

export type HumanTextInputAudit = {
  type: "text_input";
  text: string;
  sensitive: boolean;
  targetRole?: string;
  textLength?: number;
};

export function redactInputEvent(input: HumanTextInputAudit): HumanTextInputAudit {
  if (!input.sensitive) return { ...input, text: redactString(input.text) };
  return {
    ...input,
    text: "[REDACTED]",
    textLength: input.text.length,
  };
}

export function isSensitiveField(input: {
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  ariaLabel?: string | null;
}): boolean {
  const type = (input.type ?? "").toLowerCase();
  if (["password"].includes(type)) return true;
  const descriptor = [input.autocomplete, input.name, input.ariaLabel].filter(Boolean).join(" ");
  return /password|passcode|one[- ]?time|otp|verification|security code|cvv|cvc|pin/i.test(descriptor);
}
