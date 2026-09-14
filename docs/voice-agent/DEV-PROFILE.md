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
  "confirmDelegation": true
}
```

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

## 6. Checks

- Control panel chat: "open Notepad" calls `open_app` and Notepad starts.
- `run_powershell` always shows a native confirmation dialog; Cancel returns "Cancelled".
