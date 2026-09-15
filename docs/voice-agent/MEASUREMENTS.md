# Measurements

Reference machine: Windows 11, RTX 4070 Ti 12 GB (driver 595.79, CUDA 13.2), OpenWhispr dev
instance, installed OpenWhispr closed. VRAM from `nvidia-smi --query-gpu=memory.used`; the
Windows desktop alone uses about 2.9 GB.

## Components in isolation (2026-09-14)

| Component                                                                     | Setting                                     | Load  | Per call                                                  | VRAM    |
| ----------------------------------------------------------------------------- | ------------------------------------------- | ----- | --------------------------------------------------------- | ------- |
| faster-whisper `large-v3-turbo` (`deepdml/faster-whisper-large-v3-turbo-ct2`) | CUDA, `int8_float16`, beam 1, language auto | 2.8 s | 1.17 s cold, **0.22–0.44 s warm** for 2.8–5.4 s of French | +1.2 GB |
| Kokoro v1.0 ONNX, voice `ff_siwis` (`fr-fr`)                                  | CPU                                         | 0.8 s | **RTF 0.21–0.24** (0.44 s for 2.1 s of speech)            | none    |
| llama-server Vulkan, `qwen3.5-4b-q4_k_m`, context 16k                         | upstream model manager                      | —     | —                                                         | +3.9 GB |

Language detection on the five French test utterances: `fr` with probability 1.00 each time.

## Test utterances

Synthesized with the Windows `Microsoft Caroline (fr-CA)` voice, converted to 16 kHz mono PCM:

1. « Bonjour, peux-tu te présenter en une phrase ? »
2. « Quelle est la capitale de l'Australie ? »
3. « Donne-moi une astuce pour mieux dormir. »
4. « Combien font dix-sept fois trois ? » (transcribed as « Combien font 17 fois 3 ? »)
5. « Merci, c'est tout pour aujourd'hui. »

## End-to-end session (2026-09-14)

Dev app, conversation hotkey, sidecar fed with the five utterances above
(`OW_CONVERSATION_WAV_INPUT`, real-time 20 ms frames, bot audio consumed in real time). LLM
`qwen3.5-4b-q4_k_m` on the shared llama-server (Vulkan), Whisper on CUDA, Kokoro on CPU,
`sttLanguage=auto`, barge-in `mute`.

**Startup:** hotkey → session `listening` in **9.6 s**, of which 6.4 s is the sidecar loading and
warming Whisper and Kokoro. The 4B was already loaded by upstream's pre-warm.

**VRAM:** 6,810 MiB before (desktop + 4B), **8,078 MiB during** (+1.27 GB for Whisper), 6,868 MiB
after. About 4.2 GB of the 12 GB card stays free.

Latency is Pipecat's `UserBotLatencyObserver`: from the end of user speech (VAD stop minus
`stop_secs`) to the first bot audio, in milliseconds.

| Turn | Heard (Whisper)                                   | Total | VAD stop | STT | Turn end | LLM TTFB | Sentence wait | TTS first audio |
| ---- | ------------------------------------------------- | ----- | -------- | --- | -------- | -------- | ------------- | --------------- |
| 1    | « Bonjour ! Peux-tu te présenter en une phrase? » | 2,143 | 200      | 313 | 976      | 339      | 58            | 255             |
| 2    | « Quelle est la capitale de l'Australie ? »       | 2,435 | 200      | 300 | 307      | 79       | 301           | 1,246           |
| 3    | « Donne-moi une astuce pour mieux dormir. »       | 1,965 | 200      | 289 | 321      | 97       | 190           | 866             |
| 4    | « Combien font 17 fois 3 ? »                      | 1,406 | 200      | 289 | 322      | 112      | 102           | 381             |
| 5    | « Merci. C'est tout pour aujourd'hui. »           | 1,288 | 200      | 233 | 376      | 114      | 62            | 301             |

- **Median 1,965 ms**, range 1,288–2,435 ms.
- Detected language `fr` on 5/5 turns, probability ≥ 0.998.
- State sequence was `listening > user_speaking > thinking > speaking > listening` on every turn; no
  error or warning event.
- Where the time goes:
  - **Turn end** (`SpeechTimeoutUserTurnStopStrategy`, 0.6 s timeout) costs about 320 ms. Turn 1
    paid 976 ms, including the first inference.
  - **TTS first audio** grows with the length of the first sentence: Kokoro synthesizes a whole
    sentence before any audio (turn 2: a 20-word first sentence, 1,246 ms).
  - LLM time-to-first-token is 80–340 ms.
- Intelligibility: Whisper transcribed the recorded Kokoro output (`bot-output.wav`, 29.9 s) back
  to the replies almost word for word. English words are phonemized as French:
  - « OpenWhispr » came back as « Open et Nwispfl »;
  - « Windows » came back as « Windowsfl ».
- Quality: the 4B answered turn 2 with a partly wrong statement: « Il n'y a pas une seule
  capitale : Canberra est la capitale fédérale… ».

Session checks in the same run:

- Dictation was blocked during the session.
- A request to start another local model (`llama-server-start qwen3.5-9b-q4_k_m`) was refused with
  the lock error. The 4B stayed on port 8221, during and after the session.
- The second hotkey press ended the session. No `ow_conversation` process was left: the venv
  `python.exe` is a launcher, so two processes run and the stop kills the tree.

Not measured in this run:

- whisper-server restart after the session (it was not running before).
- App quit with a live session.
- A real microphone.
- Barge-in.

## Latency tuning and delegation (2026-09-14)

Five changes, then the same harness with two turns: a delegation and a simple question asked while
the worker runs.

| Change                                                                   | Effect                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------- |
| Whisper decoding: beam 1, no timestamps, no conditioning on earlier text | 289 → **298 ms**, and 500 ms on a longer sentence   |
| Turn end: speech timeout 0.6 s → 0.4 s                                   | 320 → **100 ms**                                    |
| TTS: first clause of a reply released at its comma or colon              | first audio 381 → **399 ms** (and no 1.2 s outlier) |
| LLM prefix (system prompt + tool schemas) warmed during startup          | first request 8,803 → **109–346 ms**                |
| Whisper hotwords: app name and project folder names                      | « Blin Infra » → « Blain-Infra »                    |

- **Simple question during a running task: 1,232 ms** end of speech → first audio (VAD 200, STT
  298, turn end 100, LLM 109, sentence 124, TTS 399).
- **Delegation turn: 2,429 ms** to the spoken acknowledgement (STT 500, LLM 346, the rest is the
  tool call round trip and the injected sentence).
- Startup is now load 6.2 s + LLM warm-up 0.8 s, so the session reaches `listening` in about 10 s.

Delegation, end to end in the dev app:

- The model called `delegate_task`; the main process showed its confirmation (folder, instructions,
  "sent to Anthropic"), which the harness accepted by pressing Run.
- The task ran 37 s and **succeeded**, cost $0.171, and its summary landed in the session window's
  task card and in `userData/voice-agent/tasks/<id>.md`.
- Completion was announced aloud **812 ms** after the task finished, with the fixed sentence.
- While the worker ran, the simple question was still answered in 1.2 s.

## Notes vault and MCP (2026-09-14)

Driven from the session window over CDP, against the running dev app (a mock MCP server on
127.0.0.1, the real vault):

- The declared MCP tools were listed (`mcp_mock__echo_note`, `mcp_mock__drop_note`) and the tool the
  server also offered but the configuration did not declare stayed hidden and was refused when
  called by name.
- A read ran straight away; the write waited for its native confirmation and only then reached the
  server.
- `vault_search` returned 6 notes from the real vault and `vault_read` returned a 12 KB note;
  `60_Sante/…`, `.obsidian/…` and `../../Windows/win.ini` were all refused.

Spoken, in the dev app: « Cherche dans mes notes ce que j'ai écrit aujourd'hui sur OpenWhispr, puis
résume-le en une phrase » → `vault_search("OpenWhispr")` → 6 notes → a correct one-sentence summary
of the day. Turn latency 2,210 ms (tool round trip included).

Before that run, the same question made the model call upstream's `search_notes` (OpenWhispr's own
notes, which are empty here) instead of the vault. Two tools for the same words is a choice a 4B
model gets wrong, so the app's note tools are now left out of a session when a vault is configured.

## After the rebase onto v1.10.1 (2026-09-14, night)

The same harness on the branch rebased onto `v1.10.1`, same machine, installed app closed. Three
runs, one per fixture set.

**Five French turns.** Session `listening` 26.2 s after the hotkey on the first run of the night —
`loadMs` alone was 16.7 s with a cold file cache; the next two runs loaded in 6.0 s for a 10 s
startup, as before. VRAM 7,177 MiB before, **8,504 MiB during**, 7,231 MiB after.

| Turn | Heard                                           | Total | STT | Turn end | LLM | Sentence | TTS |
| ---- | ----------------------------------------------- | ----- | --- | -------- | --- | -------- | --- |
| 1    | « Bonjour Peux-tu te présenter en une phrase? » | 2,133 | 296 | 100      | 351 | 148      | 830 |
| 2    | « Quelle est la capitale de l'Australie ? »     | 2,125 | 283 | 100      | 111 | 144      | 928 |
| 3    | « Donne-moi une astuce pour mieux dormir. »     | 1,650 | 289 | 102      | 110 | 116      | 630 |
| 4    | « Combien font 17 fois 3 ? »                    | 1,195 | 242 | 157      | 109 | 100      | 387 |
| 5    | « Merci C'est tout pour aujourd'hui. »          | 1,091 | 204 | 204      | 113 | 71       | 299 |

Median **1,650 ms**, range 1,091–2,133 ms; `fr` on 5/5 turns with probability ≥ 0.998; no error or
warning event. Dictation stayed blocked, a request for the 9B was refused while the session held
the 4B on port 8221, the second hotkey press ended the session, and no sidecar process was left.

**Delegation.** Spoken acknowledgement at **2,486 ms**; the task ran 68 s, succeeded, cost $0.318,
and its end was announced **754 ms** after it finished. The simple question asked while the worker
ran came back in 1,349 ms. The worker signed in through the standalone CLI, as it must.

**Vault and MCP.** `vault_search("OpenWhispr")` returned 7 notes and the model summarised the day
correctly, but the turn took **6,499 ms** — against 2,210 ms in the first run, for a longer answer
over a vault that has grown by a day of notes. The walk is the suspect and is worth a measurement
of its own before the next release. The guard checks all held: declared tools listed, an undeclared
one hidden and refused, a read without a dialog, a write only after its confirmation, and
`60_Sante/…`, `.obsidian/…` and `../../Windows/win.ini` all refused.
