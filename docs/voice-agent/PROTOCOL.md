# Conversation mode — sidecar protocol

The Python voice sidecar (`src/voice-agent/sidecar`) talks to the Electron main process over one
loopback WebSocket. Electron is the server; the sidecar is the only client.

Sources of truth: `src/voice-agent/shared/protocol.mjs` (JS) and
`src/voice-agent/sidecar/ow_conversation/protocol.py` (Python). Both reject anything not listed
here.

## Transport and authentication

| Rule       | Value                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Address    | `ws://127.0.0.1:<port>`, first free port in 8241–8260                                                                                                           |
| Token      | 32 random bytes, new for every sidecar launch, passed in `OW_CONVERSATION_TOKEN`                                                                                |
| Handshake  | `Authorization: Bearer <token>` (constant-time compare), `Host` must be `127.0.0.1:<port>`, no `Origin` header, loopback peer only; anything else gets HTTP 401 |
| Clients    | one; a new authenticated client replaces the previous one (close code 4000)                                                                                     |
| Frame size | 1 MiB maximum, text frames only                                                                                                                                 |
| Secrets    | an online model's key goes to the sidecar in `OW_CONVERSATION_LLM_API_KEY` and an online voice's in `OW_CONVERSATION_TTS_API_KEY`, never over the socket        |

## Envelope

```json
{ "v": 1, "type": "transcript.final", "ts": 1789420000000, "id": "tc-3", "turn": 2, "data": {} }
```

`v`, `type`, `ts` and `data` are always present. `id` is set on tool calls and their results;
`turn` is optional.

## Lifecycle

1. Electron starts the WebSocket server, then spawns `python -m ow_conversation --ws-url ... --device cuda`.
2. Sidecar connects and sends `hello`.
3. Electron answers `session.config`.
4. Sidecar loads Whisper (CUDA) and the voice (Kokoro, or OpenAI's speech service), warms them, starts the pipeline, and sends `ready`.
5. Electron moves the session to `listening`.
6. The session ends with `shutdown` (3 s grace, then a tree kill); the sidecar sends `bye` when it stops.

## Sidecar → Electron

| Type                 | `data`                                                                                                                                                          | Relayed to windows                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `hello`              | `protocol`, `pid`, `device`                                                                                                                                     | no                                                    |
| `ready`              | `device`, `loadMs`, `wavInput`                                                                                                                                  | no                                                    |
| `state`              | `event`: `user.started`, `user.stopped`, `bot.started`, `bot.stopped`, `turn.idle`, `confirm.requested`, `confirm.resolved`, `tools.started` (+ `tool`/`tools`) | yes; the session state machine ignores unknown events |
| `transcript.partial` | reserved (Whisper is segmented: no interim text)                                                                                                                | yes                                                   |
| `transcript.final`   | `text`, `language` (detected), `languageProbability`                                                                                                            | yes                                                   |
| `assistant.delta`    | `text` (LLM token chunk)                                                                                                                                        | yes                                                   |
| `assistant.final`    | `text` (full reply), `spokenText` (what was actually heard), `interrupted`                                                                                      | yes                                                   |
| `tool.call`          | `name`, `arguments`; `id` on the envelope                                                                                                                       | session window only                                   |
| `tool.cancel`        | `reason`; `id` on the envelope                                                                                                                                  | session window only                                   |
| `latency`            | `userBotMs`, `sttMs`, `llmMs`, `ttsMs`, `toolMs`, `stages`                                                                                                      | yes                                                   |
| `level`              | `value` 0–1, at most 20 per second                                                                                                                              | yes                                                   |
| `warning`            | `message`                                                                                                                                                       | yes                                                   |
| `error`              | `message`, `fatal`                                                                                                                                              | yes; `fatal` ends the session                         |
| `bye`                | —                                                                                                                                                               | no                                                    |

## Electron → sidecar

| Type             | `data`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.config` | `llm` (`baseURL`, `model`, `local`), `tools` (name, description, JSON-schema `parameters`; at most 12), `systemPrompt`, `sttLanguage` (`auto`, `fr`, `en`), `hotwords` (proper nouns for Whisper: the app and the configured project folders), `bargeIn` (`mute`, `interrupt`), `whisperModel`, `tts`: Kokoro (`provider: "kokoro"`, `modelPath`, `voicesPath`, `voice`, `speed`, `language`) or OpenAI (`provider: "openai"`, `baseURL`, `model`, `voice`, `instructions`); an app from before the voice picker sends `kokoro` instead |
| `tool.result`    | `success`, `text`; `id` of the call on the envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `say`            | `text`, spoken without entering the LLM context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `interrupt`      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mute`           | `value`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `update_tools`   | `tools`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `shutdown`       | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ping`           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Tool calls

The sidecar never executes a tool. For each LLM function call it sends `tool.call`; the main
process forwards it to the session window, which runs the tool from its registry (main-process
confirmation for `set_displays` and `run_powershell`) and answers through `session.toolResult`.
The sidecar waits up to 180 s, then sends `tool.cancel`. Tools that need a confirmation make the
sidecar say "Confirme à l'écran." while the dialog is open; the microphone stays muted until the
result arrives.

## Window events (not on the socket)

The main process also broadcasts events to the session window and the companion that do not come
from the sidecar:

| Type          | `data`                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `state`       | `state`, `event` (session state machine, owned by the main process)                                            |
| `task.update` | a background task: `id`, `title`, `project`, `status`, `progress`, `summary`, `error`, `costUsd`, `outputFile` |

When a background task finishes, the main process sends the sidecar a `say` with a fixed sentence
built from the task title. The worker output itself is never sent to the sidecar.
