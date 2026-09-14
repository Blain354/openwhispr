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

| Turn | Heard (Whisper)                                  | Total | VAD stop | STT | Turn end | LLM TTFB | Sentence wait | TTS first audio |
| ---- | ------------------------------------------------ | ----- | -------- | --- | -------- | -------- | ------------- | --------------- |
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
