# Development profile checklist

A fresh `npm run dev` starts on an empty profile (`%APPDATA%\OpenWhispr-development` on Windows):
no onboarding, no local models selected, no GPU packs. This checklist makes a profile usable for
Conversation mode work. Every item is idempotent; re-run the whole list after wiping the profile.

> Windows note for AI-assisted sessions: a dev instance started from inside a sandboxed app
> container (for example the Claude desktop app) writes new files under `%APPDATA%` into that
> container. A profile prepared there is invisible to a dev instance started from a normal
> terminal. Apply this checklist in the instance you actually use.

## 1. Start the dev app

```powershell
# Conversation tools inside upstream chats are a developer-only flag (never a UI setting).
$env:OW_CONVERSATION_TOOLS_IN_CHAT = "1"
npm run dev
```

Quit any installed OpenWhispr first: both instances would register the same global hotkeys, and
the dev instance rewrites `~/.openwhispr/cli-bridge.json`.

## 2. Onboarding

- Choose **Continue without an account**.
- Transcription: local Whisper (`turbo`), GPU acceleration on if offered.
- Finish the flow (skip optional steps).

## 3. Models (Settings → AI Models)

- **Chat** scope: Local → `qwen3.5-9b-q4_k_m` (tools require a local model of 4B or more).
- **Voice Assistant** scope: Local → `qwen3.5-9b-q4_k_m` (set it explicitly; it is only seeded
  from Chat once, at first load).
- Download the Vulkan GPU pack for the local LLM when offered (otherwise llama-server runs on CPU).
- Conversation mode itself uses `qwen3.5-4b-q4_k_m` (see `config.json` below); make sure that
  model is downloaded too.

## 4. Hotkeys (Settings → Hotkeys)

- Dictation: keep the default (`Control+Super` on Windows) or your usual key.
- Voice Assistant: `Control+Alt+F10` — not `Control+Alt+Space` (reserved for Conversation mode)
  and not a combination that starts with the dictation modifiers.

## 5. Conversation mode configuration

`<userData>/voice-agent/config.json` (created on first save; all keys optional):

```json
{
  "enabled": true,
  "hotkey": "Control+Alt+Space",
  "conversationModel": "qwen3.5-4b-q4_k_m",
  "sttLanguage": "auto",
  "bargeIn": "mute",
  "confirmDelegation": true,
  "inputDevice": "",
  "vadMinVolume": 0.4,
  "waitForCompleteTurns": true
}
```

- `inputDevice`: empty follows the microphone OpenWhispr uses; a device name forces one.
- `vadMinVolume`: loudness floor for speech (0.1–0.9, default 0.4); lower it for a quiet headset.
- `waitForCompleteTurns`: let the model wait until the user has finished speaking (default on).
- `voice`: the voice that reads the replies. Choose it in the session window's settings rather than by hand; the default is Kokoro's French voice `ff_siwis`.

`toolsInChat` can also be set here, but the environment variable in step 1 is the intended way
during development.

### Background tasks (Claude Code workers)

The voice session can delegate read-only work (files and git history) to `claude -p`. Declare the
project folders it may use, and the notes vault it must never touch:

```json
{
  "workerProjectRoots": [
    "C:\\Users\\gblai\\Documents\\github\\*",
    "C:\\Users\\gblai\\Documents\\blain-infra"
  ],
  "vaultRoot": "C:\\Users\\gblai\\SynologyDrive\\Knowledge_base",
  "workerBudgetUsd": 2
}
```

- A root ending in `*` offers each of its sub-folders as a project.
- For a single dev run, `OW_CONVERSATION_WORKER_ROOTS` takes the same list separated by `;`, and
  `OW_CONVERSATION_VAULT_ROOT` sets the vault.
- `claudePath` defaults to `%USERPROFILE%\.local\bin\claude.exe`.
- **The standalone `claude` CLI must be signed in.** Run `claude` once in a terminal and use
  `/login` if asked. A worker cannot reuse the Claude desktop app's session, and a stale CLI login
  ends every task with "Claude Code needs you to sign in again".

### When the hotkey is already taken

Windows refuses a global hotkey that another application registered first. On the reference machine
`Control+Alt+Space` and `Alt+F9` were both taken; `Control+Alt+K`, `Control+Alt+F9` and
`Control+Shift+Space` were free. When registration fails at startup, a notification appears:
click it to open the conversation window and pick another hotkey in its settings (the choice is
validated against Windows shortcuts and the other OpenWhispr hotkeys, then saved to
`config.json`).

### Notes vault (read-only)

```json
{
  "vaultRoot": "C:\\Users\\gblai\\SynologyDrive\\Knowledge_base",
  "vaultExcluded": ["00_Inbox/raw", "99_Archive"]
}
```

- `vaultExcluded` holds folder names to skip; `60_Sante`, hidden folders, anything outside the
  vault and any note whose frontmatter says `sensitive: true` or `scope: santé` are refused
  whatever the configuration says.
- Meeting notes under `00_Inbox/pocket/` only ever return their summary and action items.
- `OW_CONVERSATION_VAULT_ROOT` sets the root for a single dev run.

### MCP servers

`<userData>/voice-agent/mcp.json`:

```json
{
  "servers": [
    {
      "name": "openclaw",
      "url": "https://mcp.blain-projects.ca/mcp",
      "read": ["list_workspace_files", "read_workspace_file"],
      "write": ["drop_note"]
    }
  ]
}
```

- Exact tool names only: no wildcards, and nothing the server offers beyond this list is visible.
- At most 12 tools across all servers, and the whole file is refused if that is exceeded.
- Tools are exposed to the model as `mcp_<server>__<tool>`; a `write` tool asks for a native
  confirmation showing its arguments.
- **Tokens are typed in the session window** (Conversation settings → MCP server token). They are
  encrypted with the OS secure storage and never read back into a window; never put a token in
  `mcp.json`.

## 6. Checks

- Control panel chat: "open Notepad" calls `open_app` and Notepad starts.
- `run_powershell` always shows a native confirmation dialog; Cancel returns "Cancelled".
