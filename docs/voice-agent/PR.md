# Conversation mode — upstream pull request draft

Nothing here has been sent upstream. This is what a PR would say, and how it would be split.

## What it adds

An optional **Conversation mode**: a hotkey opens a spoken session with a local model — microphone
→ Whisper → LLM → local TTS → speaker — in a small session window with a companion overlay, while
dictation stays exactly as it is. The session can act on the machine (open an app, focus a window,
switch displays, run a reviewed PowerShell script), read the user's own Markdown notes, talk to
declared MCP servers, and hand a long read-only task to Claude Code in the background.

It is **off by default**. While it is off, no hotkey is registered, no sidecar is started, no tool is
registered and the preload bridge exposes nothing.

## How it is built

- Everything lives in `src/voice-agent/` (main process, shared pure logic, renderer, tools) plus a
  Python sidecar in `src/voice-agent/sidecar/`, which the user installs separately.
- The voice loop itself runs in the sidecar (Pipecat 1.10: faster-whisper, Silero VAD, an
  OpenAI-compatible LLM, Kokoro), because that pipeline has no equivalent in Node today. Electron
  owns the session, the windows, the secrets and every decision that needs a human.
- Electron and the sidecar talk over one loopback WebSocket with a per-launch token
  (`docs/voice-agent/PROTOCOL.md`).

## Upstream files touched

| File                                | Change                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `main.js`                           | one `require(...).install({ windowManager, whisperManager, debugLogger })`     |
| `src/services/tools/index.ts`       | one import and one `registerConversationTools(registry, settings)` call        |
| `src/AppRouter.jsx`                 | two query-param branches for the session window and the companion overlay      |
| `src/helpers/windowManager.js`      | one line in `_shouldBlockDictationInput` so dictation cannot start mid-session |
| `src/components/SettingsPage.tsx`   | one import and one `<ConversationModeSetting />` in the Hotkeys section        |
| `electron-builder.json`             | ship `src/voice-agent/**` except the Python sources                            |
| `src/locales/*/translation.json`    | the `conversation` strings (English everywhere, French written)                |
| `package.json`, `package-lock.json` | `@ai-sdk/mcp` (exact version)                                                  |
| `CHANGELOG.md`                      | one entry                                                                      |

## Security model

- **The main process is the only authority.** Every mutating action (display switch, PowerShell
  script, background task, MCP write) shows a native confirmation from the same handler that then
  performs it, defaulting to Cancel and treating a 60 s timeout as a refusal. A renderer can ask;
  it can never approve.
- **The preload bridge is exposed conditionally**: main frame only, app origin only, and a
  per-window op allowlist resolved from the sender's webContents id.
- **Children get an environment allowlist**, so the provider keys the main process holds are never
  inherited; a custom LLM key reaches the sidecar in one variable and never on the socket.
- **Background workers are walled by a `PreToolUse` hook**, because in print mode Claude Code's
  `--tools`, `--allowedTools` and `--permission-mode` did not stop a call that was not on the list
  (measured; see `README.md`). Their folder can never be the user's vault, a folder around it, a
  sealed folder or the home folder, checked again on the real path.
- **The vault is read-only** and prunes sealed, hidden and excluded folders during the walk; notes
  marked sensitive are never returned.
- **MCP servers expose only the exact tools declared** in a local file; writes are confirmed;
  tokens live in the main process behind `safeStorage` with no read op.
- Audio and transcripts never leave the machine: speech-to-text and text-to-speech are local, and
  the LLM is local unless the user points the session at their own endpoint.

## Test plan

- `npm run quality-check && npm run lint && npm test && npm run i18n:check`.
- `test/voice-agent/` covers the pure logic: hotkey overlap, app matching, PowerShell policy, IPC
  policy, environment allowlist, worker argv and guard, stream-json parsing, vault guard, MCP
  naming and host, session state machine, protocol, WebSocket authentication.
- The sidecar has its own pytest suite (protocol, tool bridge, mute strategy, text aggregation,
  session config, link).
- Measured end to end in the dev app: see `docs/voice-agent/MEASUREMENTS.md` (five-turn French
  session, delegation with a spoken acknowledgement, vault and MCP checks).

## Suggested split

1. **Foundations** — preload bridge, IPC policy, configuration, confirmation, environment
   allowlist, and the OS tools behind the developer flag.
2. **Session** — hotkey slot, session window, companion overlay, state machine, dictation gate.
3. **Sidecar** — the Python voice loop, the WebSocket protocol, the VRAM coordination.
4. **Tools** — background workers, the vault and the MCP client.

Each part is useful on its own and can be reviewed without the next.

## Naming

Upstream already has a `voiceAgent` hotkey slot (a one-shot dictation command). Everything here is
named `conversation*` — slot, config file, IPC channels, windows — so the two never collide.

## Limits, stated up front

- Windows only for the OS tools (they shell out to PowerShell and `explorer.exe`); the rest is
  platform-neutral but has only been run on Windows.
- The sidecar is a separate Python environment the user installs; it is not packaged with the app.
- Barge-in is "mute while the bot speaks"; interrupting by voice is not enabled yet.
- Whisper is segmented, so there is no partial transcript.
- A session pins the local model server to one model; another model cannot be started meanwhile.

`docs/voice-agent/DEV-PROFILE.md` is a fork-only checklist with machine-specific paths and would not
be part of the pull request.
