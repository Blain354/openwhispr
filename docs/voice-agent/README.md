# Conversation mode (voice agent) — fork notes

This folder documents the `feat/voice-agent` branch of `Blain354/openwhispr`: an optional
"Conversation mode" that adds a spoken session (local STT → LLM → local TTS) on top of
OpenWhispr without forking its hot paths. Everything lives under `src/voice-agent/`; upstream
files are touched only at the hook points listed below.

- `DEV-PROFILE.md` — checklist to prepare a development profile (onboarding, local models, flags).
- `PROTOCOL.md` — loopback WebSocket contract between Electron and the Python sidecar.
- `MEASUREMENTS.md` — latency and VRAM measurements.
- `PR.md` — upstream pull request draft (not submitted).

## Remotes

```bash
git remote -v
# origin    https://github.com/Blain354/openwhispr (fetch/push)
# upstream  https://github.com/OpenWhispr/openwhispr (fetch) / no_push (push)
```

`upstream` has its push URL set to `no_push` on purpose: nothing is pushed upstream from this
clone. `gh repo set-default Blain354/openwhispr` keeps `gh issue`/`gh pr` on the fork.

The branch is cut from a release tag, never from `main`:

```bash
git fetch upstream --tags
git switch -c feat/voice-agent v1.10.1
```

## Upstream files touched by the branch

Every other change lives in `src/voice-agent/`, `test/voice-agent/` or `docs/voice-agent/`.
When a rebase conflicts, it can only conflict here.

| File                                             | What the branch adds                                                                                                  | Resolution recipe                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.js`                                        | one `require("./src/voice-agent/main/install").install({...})` call right after `registerSidecars();` in `startApp()` | take upstream's file, re-insert the single call after `registerSidecars();` (or wherever sidecars are registered, before the first window is created) |
| `src/services/tools/index.ts`                    | one import and one `registerConversationTools(registry, settings)` call before `return registry;`                     | take upstream's file, re-add the import and the call as the last registration                                                                         |
| `electron-builder.json`                          | `"src/voice-agent/**/*"` (minus Python sources) in `files`                                                            | take upstream's file, re-add the entry to the `files` array                                                                                           |
| `src/AppRouter.jsx`                              | two query-param branches (`conversation-session`, `conversation-companion`) with `React.lazy` + `Suspense`            | take upstream's file, re-add both branches next to the other query-param windows                                                                      |
| `src/helpers/windowManager.js`                   | one line in `_shouldBlockDictationInput` that blocks new dictation while a session is active                          | take upstream's file, re-add the line at the top of the method (it must not block the stop of a running dictation)                                    |
| `package.json`, `package-lock.json`              | `@ai-sdk/mcp` (exact version)                                                                                         | take upstream's lockfile and `package.json`, then run `npm install @ai-sdk/mcp@1.0.80 --save-exact`; never hand-merge a lockfile                      |
| `src/components/SettingsPage.tsx`                | one import and `<ConversationModeSetting />` as the first block of the Hotkeys section                                | take upstream's file, re-add the import and the one line                                                                                              |
| `src/locales/*/translation.json`, `CHANGELOG.md` | the `conversation` strings in the 11 languages and one changelog entry (last commit of the branch)                    | drop this commit before the rebase and replay it on top afterwards; the strings are one `conversation` key per file                                   |

The feature's own setting lives in `<userData>/voice-agent/config.json`, not in `settingsStore.ts`:
the main process needs it before any window exists, to decide whether to register the hotkey at
all. The settings page reads and writes it through the conversation bridge.

## Rebasing on a new upstream tag

```bash
git fetch upstream --tags
git switch feat/voice-agent
OLD_SHA=$(git rev-parse HEAD)                     # lease value for the push below
git rebase --onto vNEW vOLD feat/voice-agent      # e.g. --onto v1.10.2 v1.10.1
# resolve conflicts with the recipes above, then:
npm ci
npm run quality-check && npm run lint && npm test && npm run i18n:check
git push --force-with-lease=feat/voice-agent:$OLD_SHA --force-if-includes origin feat/voice-agent
```

`--force-with-lease` is only ever used on `feat/voice-agent` of the fork, with an explicit lease
value: a bare lease is refreshed by `git fetch` and protects nothing.

### Smoke test after a rebase

1. `npm run dev` starts (Vite on `127.0.0.1:5183`, Electron window visible).
2. With conversation tools enabled, the session window lists `open_app`, `focus_window`,
   `set_displays` and `run_powershell`.
3. The conversation hotkey (default `Control+Alt+Space`) opens and closes a session without
   starting a dictation.

## Running the test suite on Windows

**Always isolate the model cache before `npm test`:**

```powershell
$env:OPENWHISPR_CACHE_ROOT = Join-Path $env:TEMP "openwhispr-test-cache"
npm test
```

At `v1.10.1`, `test/helpers/localReasoningBridgeChain.test.js` stubs Electron's home directory but
`src/helpers/modelDirUtils.js` prefers `USERPROFILE` on Windows, so the test writes a 1 MB fake
model over the first registry model (`Qwen_Qwen3.5-9B-Q4_K_M.gguf`) in the real
`%USERPROFILE%\.cache\openwhispr\models`. Upstream CI runs on Linux and never sees it. With
`OPENWHISPR_CACHE_ROOT` set, the cache resolves into the temporary folder instead.

A clean Windows checkout of `v1.10.1` also has pre-existing test failures (200 of 4,119 on the
reference machine, mostly Linux/macOS-specific); compare against that baseline rather than zero.

## Python sidecar environment

The sidecar's virtual environment and model caches never live inside the repository (upstream's
prettier/eslint/test scans walk dot folders under `src/`) nor under `%APPDATA%`:

```powershell
$env:UV_PROJECT_ENVIRONMENT = "$env:USERPROFILE\.cache\openwhispr\conversation\venv"
$env:PYTHONDONTWRITEBYTECODE = "1"
uv sync --project src/voice-agent/sidecar
uv run --project src/voice-agent/sidecar python src/voice-agent/sidecar/scripts/fetch_models.py
```

- The venv is where Electron looks for `Scripts\python.exe`; without it, a session reports that
  the voice engine is not installed.
- Kokoro files go to `%USERPROFILE%\.cache\openwhispr\conversation\kokoro\` (sha256-checked).
  Whisper large-v3-turbo (CTranslate2) goes to the Hugging Face cache.
- The sidecar runs with `HF_HUB_OFFLINE=1`, so a session never downloads anything.
- CUDA libraries come from the `nvidia-*-cu12` wheels; `cuda_env.py` puts their `bin` folders on
  `PATH` before faster-whisper is imported.

Sidecar tests (no GPU, no network):

```powershell
cd src/voice-agent/sidecar
& "$env:USERPROFILE\.cache\openwhispr\conversation\venv\Scripts\python.exe" -m pytest -q tests
```

## Background workers: what actually enforces "read-only"

A voice session can delegate a long task to `claude -p`. The scope is enforced by a **PreToolUse
hook** (`src/voice-agent/main/workerGuard.cjs`), not by the CLI's permission flags.

Measured on Claude Code 2.1.233 in print mode: a worker started with `--tools Read,Grep,Glob,Bash`,
an `--allowedTools` list of git read commands and `--permission-mode dontAsk` still ran `whoami`.
So did the same worker with `--permission-mode manual`, and with `--setting-sources ""`. With the
hook in front of every tool call, that request is denied and the denial is reported in the result's
`permission_denials`; `git status` still runs.

Blocked calls are recorded on the task, not treated as a failure by themselves: a worker asked for
today's commits tried `cd … && git log`, then `git -C <path> log` — both refused by the guard — and
then plain `git log`, which ran. A run that ends without an answer, denials included, fails.

The hook is one layer of three: `--tools` narrows the tool set, the worker prompt states the scope,
and the hook decides. If the hook itself cannot run, Claude Code logs a hook error and carries on,
so it fails open — which is why the other two layers stay. It runs under this app's own binary
(`ELECTRON_RUN_AS_NODE`), so it does not need Node on PATH.

## Notes vault and MCP servers

Both are evaluated in the main process; the session window only asks.

- **Vault**: `vault_search` and `vault_read` walk a Markdown vault read-only. Sealed (`60_Sante`),
  hidden and excluded folders are pruned during the walk rather than filtered afterwards, links are
  not followed, every path is re-checked on its real path, and a note marked `sensitive: true` (or
  `scope: santé`) is never returned. Meeting notes under `00_Inbox/pocket/` return only their
  summary and action items. The audit log records how many notes matched, never the query text.
- **MCP**: servers and their exact tool names come from `<userData>/voice-agent/mcp.json`. Tools are
  exposed as `mcp_<server>__<tool>`, a `write` tool is confirmed in a native dialog that shows its
  arguments, and the name is checked against the configuration again at call time. Tokens live in
  the main process (`safeStorage`), are written from the session window and never read back.

### Development harness (recorded turns instead of the microphone)

With `NODE_ENV=development` (as set by `npm run dev`), `OW_CONVERSATION_WAV_INPUT` makes the
sidecar play `turn1.wav`, `turn2.wav`… (16 kHz mono PCM) instead of opening the microphone. Each
turn waits until the bot has answered and stayed silent for 1.5 s. Bot audio is not played but
recorded to `bot-output.wav` in the same folder, in real time, so latencies stay realistic.

```powershell
$env:OW_CONVERSATION_ENABLED = "1"
$env:OW_CONVERSATION_WAV_INPUT = "C:\path\to\fixtures"
npm run dev
```
