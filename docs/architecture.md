# CPTR User-Chrome Architecture

## Trust boundaries

1. **ChatGPT / plugin** — normal MCP bearer remains server-side in `chatgpt-computer-plugin`.
2. **CPTR backend** — durable authority for device ownership, browser sessions, lease epochs, pairing approval, replay sequence, and handoff transitions.
3. **Browser-device channel** — extension authenticates with a revocable device-specific credential; control and visual traffic are separate.
4. **Chrome boundary** — the MV3 extension alone owns `chrome.debugger` and translates bounded protocol actions to allowlisted Chrome APIs/CDP.
5. **Human input boundary** — high-frequency input is prompt/session-bound but does not use ordinary MCP tool traffic.

## Browser lease

A mutation lease is identified by device, tab, browser session, owner, and epoch. CPTR is authoritative; the extension maintains a fail-closed mirror.

```text
NONE → AGENT_CONTROL → HUMAN_CONTROL → AGENT_CONTROL
        epoch +1          epoch +1       epoch +1
```

Every mutating agent request carries `expected_epoch`. Any owner or epoch mismatch rejects the mutation.

## Fresh handback protocol

HUMAN → AGENT is not a simple toggle:

1. CPTR validates the current human epoch.
2. CPTR sends `browser.handoff.prepare_return` while ownership remains HUMAN.
3. The extension captures a fresh accessibility snapshot, replacing snapshot-scoped refs.
4. If capture fails or times out, ownership remains HUMAN.
5. CPTR commits HUMAN → AGENT, increments the epoch, records the new snapshot ID, and emits `browser.handoff.returned`.
6. The extension invalidates prior refs and accepts agent mutation only at the new epoch.

## Reconnect and MV3 recovery

- Device transport authenticates after WebSocket open; credentials never appear in the URL.
- `resume_from` is the last accepted server sequence.
- Duplicate/lower sequences are dropped client-side.
- Command IDs use a bounded dedupe set.
- CPTR replays only events with sequence greater than the cursor.
- Active non-secret session state is mirrored to `chrome.storage.session`.
- On service-worker startup the extension restores and reattaches the selected tab before control/visual WebSockets begin replay.

## Visual plane

The visual socket is separate from control traffic. Frames are captured only according to the adaptive policy, privacy-masked before transmission, and dropped under backpressure. The visual queue is latest-frame-wins. Hidden/offscreen Workbench visibility is propagated back to the source and forces 0 FPS.

## Perception and refs

Accessibility is the primary model-facing perception mechanism. Each snapshot replaces the complete ref map. Refs are valid only for their current snapshot ID. Navigation and handoff invalidate prior refs.

Sensitive editable roles suppress AX values. DOM inspection is snapshot-scoped and bounded. Sensitive attributes are redacted.

## CDP policy

`DebuggerController` accepts only explicit allowlisted CDP commands. Browser actions are implemented through dedicated controllers rather than exposing raw CDP.

`select_option`, `check`, and `uncheck` use fixed hardcoded `Runtime.callFunctionOn` functions on a resolved snapshot-scoped node. Caller-provided JavaScript is never used for those actions.

`evaluate` is the sole arbitrary-expression feature and requires a short-lived one-time CPTR approval token bound to user, session, and exact expression. The extension requests only by-value results, rejects remote object handles, redacts results, and caps result size.

## Privacy

Never persist or expose:

- MCP bearer tokens in extension state or traffic
- device credential hashes to clients
- cookies or Authorization headers
- request/response bodies through network observability
- password/MFA field values in accessibility output
- human sensitive input plaintext in audit/activity telemetry
- user-Chrome free-form text or evaluate expressions in plugin MCP activity

Screenshots are masked before leaving the browser process. Browser network and console buffers are bounded to 200 projected events.

## File upload policy

Arbitrary `DOM.setFileInputFiles` is intentionally disabled because CPTR currently has no explicit trusted mapping from an authorized connector/workspace file to a browser-host filesystem path. Until such a broker exists, file selection requires HUMAN_CONTROL and Chrome's native file picker.

## Qualification evidence

The extension suite includes protocol, pairing, auth, debugger allowlist, stale refs, lease/epoch, handoff, masking, adaptive frame streaming, reconnect/idempotency, service-worker recovery, observability redaction, evaluate approval, and deterministic soak tests. Soak coverage includes 100 complete AGENT↔HUMAN ownership cycles and 1,000 replay/dedupe events while asserting bounded state.
