# CPTR Live Computer Chrome Extension

Manifest V3 device endpoint for controlling a user-approved everyday Chrome profile through CPTR and the `cptr_user_chrome` ChatGPT tool.

## Architecture

```text
ChatGPT
  → chatgpt-computer-plugin
  → CPTR backend
  → authenticated browser-device control + visual channels
  → chatgpt-chrome-extension
  → chrome.debugger / Chrome DevTools Protocol
  → the user's selected normal Chrome tab
```

This integration is intentionally separate from CPTR's isolated `cptr_chrome_browser` implementation.

## Security model

- The extension never receives the MCP bearer token.
- Pairing uses a short-lived challenge followed by a device-specific credential.
- The backend stores device credentials and claim secrets as hashes only.
- Every mutating agent command is fenced by an authoritative lease epoch.
- Exactly one mutation owner is allowed at a time: `agent` or `human`.
- HUMAN → AGENT return requires a fresh accessibility snapshot before the backend increments the epoch.
- Password/MFA-like field values are suppressed from accessibility snapshots.
- Screenshot masking happens in the extension before visual frames leave Chrome.
- Network observability stores no request/response bodies, cookies, or headers.
- Console/network buffers are bounded.
- `Runtime.evaluate` requires a short-lived one-time CPTR approval token bound to the exact user, session, and expression. Results must be serializable by value.
- Sensitive user-Chrome text/expression/approval-token arguments are redacted before plugin activity telemetry.

## Build and test

Requirements: Node.js 22 or newer.

```bash
npm ci
npm run check
```

`npm run check` runs strict TypeScript, ESLint, Vitest, and the production build. The protocol suite also verifies the implementation against `contracts/browser-protocol-v1.json`, which must stay identical to the plugin and CPTR backend copies. The unpacked extension is emitted to `dist/`.

CI runs the same `npm run check` gate on pull requests and `main`. Generated `release-*` and `hotfix-*` packaging directories are ignored so release output cannot silently become source input.

## Install in Chrome

1. Build the extension with `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the generated `dist/` directory.
5. Open the extension options page and enter the trusted CPTR origin.
6. Request pairing, approve the displayed pairing challenge through authenticated CPTR controls, then claim the device credential.

Host access should be granted only to the CPTR origin being paired.

## Session lifecycle

A CPTR browser session binds one paired device and one Chrome tab. Session bootstrap is transactional: CPTR acquires the agent lease, sends `attach`, waits for the extension to confirm debugger attachment, and only then reports `AGENT_CONTROL`.

The extension stores only non-secret session/lease recovery metadata in `chrome.storage.session` so an MV3 service-worker restart can restore the same tab, owner, epoch, and session before WebSocket replay resumes.

## Human takeover

1. CPTR transfers `agent → human`, increments the epoch, and sends the authoritative handoff message to the extension.
2. Human input travels over the browser control channel, not ordinary MCP calls.
3. Agent mutations with stale/wrong epochs are rejected by both CPTR and the extension lease mirror.
4. Returning control first requests a fresh accessibility snapshot while the human lease is still active.
5. Only after that succeeds does CPTR transfer `human → agent`, increment the epoch, invalidate stale refs, and emit `browser.handoff.returned`.

## Visual streaming

Visual traffic uses a separate authenticated WebSocket. Frames are privacy-masked before transmission and latest-frame-wins under backpressure. The Workbench paints image bytes directly to Canvas rather than storing frames in React state.

When the Workbench is hidden/offscreen, visibility configuration propagates back to the extension and source capture stops at 0 FPS.

## Supported browser capabilities

Current implementation includes:

- tab/window list, activate, open, duplicate, close, focus, create window
- navigation, back/forward/reload/stop, bounded wait-for-navigation
- accessibility snapshots with snapshot-scoped refs
- screenshot masking and visual streaming
- URL/title, bounded text/HTML/attribute inspection, accessibility `find`, bounded `wait_for`
- click/double/right-click/hover/focus
- type/fill/clear/key down/up/press/scroll/drag
- constrained select/check/uncheck using hardcoded node-scoped functions
- dialogs and bounded PDF generation
- downloads/list/cancel with sanitized metadata
- bounded/redacted network and console observability
- approval-gated `evaluate`
- real-time human pointer/touch/key/text/wheel input
- reconnect replay, command dedupe, worker-restart recovery

## Intentional limitation: file upload

`upload_file` is not enabled for arbitrary MCP-provided filesystem paths. `DOM.setFileInputFiles` requires host-local paths and would create a new file-access trust boundary. Until CPTR has an explicit approved file broker that maps authorized connector/workspace files to browser-host paths, uploads should be completed in HUMAN_CONTROL through Chrome's native file picker.

## Cross-repo release discipline

The plugin repository owns the aggregate cross-repo compatibility/release runbook at `docs/cross-repo-release-gate.md`. Browser protocol changes are not complete until the plugin, backend, and extension manifests converge and all repository-local gates pass. Breaking wire changes require a protocol-version transition; do not silently replace protocol v1.

## Development invariants

- Do not add `--remote-debugging-port`.
- Do not extract cookies or browser storage.
- Do not route high-frequency human input through normal MCP.
- Do not add generic arbitrary CDP dispatch.
- Keep all queues/buffers/timeouts bounded.
- Preserve the single persistent Live Workbench surface.
