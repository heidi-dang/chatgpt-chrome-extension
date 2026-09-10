import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const BROWSER_ACTIONS = [
  "status",
  "attach",
  "detach",
  "list_tabs",
  "open_dedicated",
  "batch",
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

export const BATCHABLE_BROWSER_ACTIONS = [
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
] as const satisfies readonly BrowserAction[];

const BATCHABLE_ACTIONS = new Set<BrowserAction>(BATCHABLE_BROWSER_ACTIONS);
const MAX_BATCH_STEPS = 24;

const MUTATING_ACTIONS = new Set<BrowserAction>([
  "attach",
  "batch",
  "detach",
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

export function actionCanBatch(action: BrowserAction): boolean {
  return BATCHABLE_ACTIONS.has(action);
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
  if (payload.action !== "batch") return;
  const steps = payload.args.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_BATCH_STEPS) {
    ctx.addIssue({
      code: "custom",
      path: ["args", "steps"],
      message: `Batch requires 1-${MAX_BATCH_STEPS} bounded browser steps`,
    });
    return;
  }
  for (const [index, value] of steps.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      ctx.addIssue({ code: "custom", path: ["args", "steps", index], message: "Batch step must be an object" });
      continue;
    }
    const step = value as Record<string, unknown>;
    if (typeof step.action !== "string" || !BATCHABLE_ACTIONS.has(step.action as BrowserAction)) {
      ctx.addIssue({ code: "custom", path: ["args", "steps", index, "action"], message: "Batch step action is not allowed" });
    }
    if (step.args !== undefined && (!step.args || typeof step.args !== "object" || Array.isArray(step.args))) {
      ctx.addIssue({ code: "custom", path: ["args", "steps", index, "args"], message: "Batch step args must be an object" });
    }
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

const browserOwnerSchema = z.enum(["none", "agent", "human"]);
const snapshotIdSchema = z.string().min(1).max(200);

const sessionStopMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.session.stop"),
  command_id: z.string().min(1).max(200).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

const handoffAcceptedMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.handoff.accepted"),
  payload: z.object({
    owner: z.literal("human"),
    epoch: z.number().int().nonnegative(),
    snapshot_id: snapshotIdSchema.nullable().optional(),
  }).strict(),
}).strict();

const handoffPrepareReturnMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.handoff.prepare_return"),
  command_id: z.string().min(1).max(200),
  payload: z.object({
    expected_epoch: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const handoffReturnedMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.handoff.returned"),
  payload: z.object({
    owner: z.literal("agent"),
    epoch: z.number().int().nonnegative(),
    snapshot_id: snapshotIdSchema,
  }).strict(),
}).strict();

const handoffCancelledMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.handoff.cancelled"),
  payload: z.object({
    owner: z.literal("none"),
    epoch: z.number().int().nonnegative(),
    snapshot_id: snapshotIdSchema.nullable().optional(),
  }).strict(),
}).strict();

const handoffRejectedMessageSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("browser.handoff.rejected"),
  payload: z.object({
    owner: browserOwnerSchema,
    epoch: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const serverMessageSchemasByType = {
  "browser.command": browserCommandMessageSchema,
  "browser.human.input": humanInputMessageSchema,
  "browser.stream.configure": streamConfigureMessageSchema,
  "browser.session.stop": sessionStopMessageSchema,
  "browser.handoff.accepted": handoffAcceptedMessageSchema,
  "browser.handoff.prepare_return": handoffPrepareReturnMessageSchema,
  "browser.handoff.returned": handoffReturnedMessageSchema,
  "browser.handoff.cancelled": handoffCancelledMessageSchema,
  "browser.handoff.rejected": handoffRejectedMessageSchema,
} as const;

export type BrowserCommandMessage = z.infer<typeof browserCommandMessageSchema>;
export type HumanInputMessage = z.infer<typeof humanInputMessageSchema>;
export type ServerMessage =
  | z.infer<typeof browserCommandMessageSchema>
  | z.infer<typeof humanInputMessageSchema>
  | z.infer<typeof streamConfigureMessageSchema>
  | z.infer<typeof sessionStopMessageSchema>
  | z.infer<typeof handoffAcceptedMessageSchema>
  | z.infer<typeof handoffPrepareReturnMessageSchema>
  | z.infer<typeof handoffReturnedMessageSchema>
  | z.infer<typeof handoffCancelledMessageSchema>
  | z.infer<typeof handoffRejectedMessageSchema>;

type ServerMessageType = keyof typeof serverMessageSchemasByType;

function isServerMessageType(value: string): value is ServerMessageType {
  return Object.prototype.hasOwnProperty.call(serverMessageSchemasByType, value);
}

export class ProtocolValidationError extends Error {
  constructor(message: string, readonly issues: readonly z.core.$ZodIssue[] = []) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

export function parseServerMessage(value: unknown): ServerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError("Invalid browser protocol message: expected an object");
  }
  const record = value as Record<string, unknown>;
  if (record.protocol_version !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(`Unsupported protocol version: ${String(record.protocol_version)}`);
  }
  if (typeof record.type !== "string" || !record.type) {
    throw new ProtocolValidationError("Invalid browser protocol message at type: expected a non-empty string");
  }
  if (!isServerMessageType(record.type)) {
    throw new ProtocolValidationError(`Unsupported browser protocol message type: ${record.type}`);
  }
  const schema = serverMessageSchemasByType[record.type];
  const parsed = schema.safeParse(value);
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
