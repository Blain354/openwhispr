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
git switch -c feat/voice-agent v1.10.0
```

## Upstream files touched by the branch

Every other change lives in `src/voice-agent/`, `test/voice-agent/` or `docs/voice-agent/`.
When a rebase conflicts, it can only conflict here.

| File                                                                                                               | What the branch adds                                                                                                  | Resolution recipe                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.js`                                                                                                          | one `require("./src/voice-agent/main/install").install({...})` call right after `registerSidecars();` in `startApp()` | take upstream's file, re-insert the single call after `registerSidecars();` (or wherever sidecars are registered, before the first window is created) |
| `src/services/tools/index.ts`                                                                                      | one import and one `registerConversationTools(registry, settings)` call before `return registry;`                     | take upstream's file, re-add the import and the call as the last registration                                                                         |
| `electron-builder.json`                                                                                            | `"src/voice-agent/**/*"` (minus Python sources) in `files`                                                            | take upstream's file, re-add the entry to the `files` array                                                                                           |
| `src/AppRouter.jsx`                                                                                                | two query-param branches (`conversation-session`, `conversation-companion`) with `React.lazy` + `Suspense`            | take upstream's file, re-add both branches next to the other query-param windows                                                                      |
| `src/helpers/windowManager.js`                                                                                     | one line in `_shouldBlockDictationInput` that blocks new dictation while a session is active                          | take upstream's file, re-add the line at the top of the method (it must not block the stop of a running dictation)                                    |
| `package.json`, `package-lock.json`                                                                                | `@ai-sdk/mcp` (exact version)                                                                                         | take upstream's lockfile and `package.json`, then run `npm install @ai-sdk/mcp@1.0.80 --save-exact`; never hand-merge a lockfile                      |
| `src/stores/settingsStore.ts`, `src/components/SettingsPage.tsx`, `src/locales/*/translation.json`, `CHANGELOG.md` | upstream-ready setting, i18n and changelog (last commit of the branch only)                                           | drop this commit before the rebase and replay it on top afterwards                                                                                    |

## Rebasing on a new upstream tag

```bash
git fetch upstream --tags
git switch feat/voice-agent
OLD_SHA=$(git rev-parse HEAD)                     # lease value for the push below
git rebase --onto vNEW vOLD feat/voice-agent      # e.g. --onto v1.10.1 v1.10.0
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

At `v1.10.0`, `test/helpers/localReasoningBridgeChain.test.js` stubs Electron's home directory but
`src/helpers/modelDirUtils.js` prefers `USERPROFILE` on Windows, so the test writes a 1 MB fake
model over the first registry model (`Qwen_Qwen3.5-9B-Q4_K_M.gguf`) in the real
`%USERPROFILE%\.cache\openwhispr\models`. Upstream CI runs on Linux and never sees it. With
`OPENWHISPR_CACHE_ROOT` set, the cache resolves into the temporary folder instead.

A clean Windows checkout of `v1.10.0` also has pre-existing test failures (198 of 3,809 on the
reference machine, mostly Linux/macOS-specific); compare against that baseline rather than zero.

## Python sidecar environment

The sidecar's virtual environment and model caches never live inside the repository (upstream's
prettier/eslint/test scans walk dot folders under `src/`) nor under `%APPDATA%`:

```powershell
$env:UV_PROJECT_ENVIRONMENT = "$env:USERPROFILE\.cache\openwhispr\conversation\venv"
uv sync --project src/voice-agent/sidecar
```

Models are cached under `%USERPROFILE%\.cache\openwhispr\conversation\`.
