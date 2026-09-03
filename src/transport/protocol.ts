import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const BROWSER_ACTIONS = [
  "status",
  "devices",
  "attach",
  "detach",
  "list_tabs",
  "get_tab",
  "activate_tab",
  "open_tab",
  "close_tab",
  "duplicate_tab",
  "list_windows",
  "new_window",
  "focus_window",
  "navigate",
  "back",
  "forward",
  "reload",
  "stop",
  "wait_for_navigation",
  "snapshot",
  "screenshot",
  "get_text",
  "get_html",
  "get_attribute",
  "get_url",
  "get_title",
  "find",
  "click",
  "double_click",
  "right_click",
  "hover",
  "type",
  "fill",
  "clear",
  "press_key",
  "key_down",
  "key_up",
  "scroll",
  "drag",
  "select_option",
  "check",
  "uncheck",
  "focus",
  "evaluate",
  "wait_for",
  "handle_dialog",
  "print_pdf",
  "download",
  "list_downloads",
  "cancel_download",
  "network_enable",
  "network_events",
  "console",
] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export const HUMAN_INPUT_TYPES = [
  "pointer_move",
  "pointer_down",
  "pointer_up",
  "click",
  "double_click",
  "wheel",
  "key_down",
  "key_up",
  "text_input",
  "touch_start",
  "touch_move",
  "touch_end",
  "focus",
  "blur",
  "viewport_resize",
  "drag_start",
  "drag_move",
  "drag_end",
] as const;

export type HumanInputType = (typeof HUMAN_INPUT_TYPES)[number];
export type BrowserMode = "DISCONNECTED" | "OBSERVING" | "AGENT_CONTROL" | "HANDOFF_REQUIRED" | "HUMAN_CONTROL";

const MUTATING_ACTIONS = new Set<BrowserAction>([
  "activate_tab",
  "open_tab",
  "close_tab",
  "duplicate_tab",
  "new_window",
  "focus_window",
  "navigate",
  "back",
  "forward",
  "reload",
  "stop",
  "click",
  "double_click",
  "right_click",
  "hover",
  "type",
  "fill",
  "clear",
  "press_key",
  "key_down",
  "key_up",
  "scroll",
  "drag",
  "select_option",
  "check",
  "uncheck",
  "focus",
  "evaluate",
  "handle_dialog",
  "print_pdf",
  "download",
  "cancel_download",
  "network_enable",
]);

export function actionMutatesBrowser(action: BrowserAction): boolean {
  return MUTATING_ACTIONS.has(action);
}

const modeSchema = z.enum([
  "DISCONNECTED",
  "OBSERVING",
  "AGENT_CONTROL",
  "HANDOFF_REQUIRED",
  "HUMAN_CONTROL",
]);

const baseEnvelopeFields = {
  protocol_version: z.literal(PROTOCOL_VERSION),
  session_id: z.string().min(1).max(200),
  surface_id: z.string().min(1).max(200),
  device_id: z.string().min(1).max(200),
  sequence: z.number().int().nonnegative(),
  timestamp: z.iso.datetime({ offset: true }),
  source: z.enum(["cptr", "extension", "live_ui", "human", "agent"]),
  mode: modeSchema,
};

const commandPayloadSchema = z.object({
  action: z.enum(BROWSER_ACTIONS),
  expected_epoch: z.number().int().nonnegative().optional(),
  args: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((payload, ctx) => {
  if (actionMutatesBrowser(payload.action) && payload.expected_epoch === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["expected_epoch"],
      message: "Mutating browser action requires expected lease epoch",
    });
  }
});

const browserCommandMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.command"),
  command_id: z.string().min(1).max(200),
  payload: commandPayloadSchema,
}).strict();

const humanInputPayloadSchema = z.object({
  input_type: z.enum(HUMAN_INPUT_TYPES),
  expected_epoch: z.number().int().nonnegative(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  delta_x: z.number().optional(),
  delta_y: z.number().optional(),
  button: z.enum(["none", "left", "middle", "right", "back", "forward"]).optional(),
  key: z.string().max(128).optional(),
  code: z.string().max(128).optional(),
  text: z.string().max(20_000).optional(),
  modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4).optional(),
  pointer_id: z.number().int().nonnegative().optional(),
  width: z.number().positive().max(16_384).optional(),
  height: z.number().positive().max(16_384).optional(),
  sensitive: z.boolean().optional(),
}).strict();

const humanInputMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.human.input"),
  command_id: z.string().min(1).max(200),
  payload: humanInputPayloadSchema,
}).strict();

const streamConfigureMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.stream.configure"),
  command_id: z.string().min(1).max(200).optional(),
  payload: z.object({
    visible: z.boolean(),
    max_fps: z.number().int().min(0).max(12),
    max_width: z.number().int().min(320).max(3_840),
    quality: z.number().int().min(20).max(90),
  }).strict(),
}).strict();

const simpleServerMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.enum([
    "browser.ping",
    "browser.session.stop",
    "browser.handoff.accepted",
    "browser.handoff.prepare_return",
    "browser.handoff.returned",
    "browser.handoff.cancelled",
  ]),
  command_id: z.string().min(1).max(200).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

const serverMessageSchema = z.union([
  browserCommandMessageSchema,
  humanInputMessageSchema,
  streamConfigureMessageSchema,
  simpleServerMessageSchema,
]);

export type BrowserCommandMessage = z.infer<typeof browserCommandMessageSchema>;
export type HumanInputMessage = z.infer<typeof humanInputMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export class ProtocolValidationError extends Error {
  constructor(message: string, readonly issues: readonly z.core.$ZodIssue[] = []) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

export function parseServerMessage(value: unknown): ServerMessage {
  if (value && typeof value === "object" && "protocol_version" in value) {
    const version = (value as { protocol_version?: unknown }).protocol_version;
    if (version !== PROTOCOL_VERSION) {
      throw new ProtocolValidationError(`Unsupported protocol version: ${String(version)}`);
    }
  }
  const parsed = serverMessageSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new ProtocolValidationError(
      `Invalid browser protocol message${location}: ${issue?.message ?? "validation failed"}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}
