"""Voice preview: ``python -m ow_conversation.preview`` reads a voice as JSON on stdin and writes a
short WAV sample of it on stdout.

Used by the session window's voice picker, outside any session. No pipecat import, so a preview
starts in about a second: Kokoro is read in-process, OpenAI's speech endpoint is called with the key
from ``OW_CONVERSATION_TTS_API_KEY``. Nothing is written to disk.
"""

from __future__ import annotations

import io
import json
import os
import sys
import wave
from collections.abc import Callable
from typing import Any

from .session_config import TtsConfig, parse_tts_config

MAX_PREVIEW_BYTES = 8 * 1024 * 1024
OPENAI_SAMPLE_RATE = 24000
PREVIEW_TEXT = {
    "fr": "Bonjour ! Voici la voix que j'utiliserai pendant nos conversations.",
    "en": "Hello! This is the voice I will use in our conversations.",
}


def preview_text(language: str) -> str:
    """The sample sentence, in the language the voice will read."""
    return PREVIEW_TEXT["en"] if str(language or "").lower().startswith("en") else PREVIEW_TEXT["fr"]


def wav_bytes(pcm16: bytes, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm16)
    return buffer.getvalue()


def kokoro_pcm(
    tts: TtsConfig, text: str, kokoro_factory: Callable[[str, str], Any] | None = None
) -> tuple[bytes, int]:
    import numpy as np

    if kokoro_factory is None:
        for path in (tts.model_path, tts.voices_path):
            if not os.path.isfile(path):
                raise FileNotFoundError(path)
        from kokoro_onnx import Kokoro

        kokoro_factory = Kokoro
    kokoro = kokoro_factory(tts.model_path, tts.voices_path)
    samples, sample_rate = kokoro.create(text, voice=tts.voice, speed=tts.speed, lang=tts.language)
    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767).astype("<i2")
    return pcm.tobytes(), int(sample_rate)


def openai_pcm(tts: TtsConfig, text: str, client_factory: Callable[..., Any] | None = None) -> tuple[bytes, int]:
    """The same request the session's OpenAITTSService sends: raw 24 kHz PCM."""
    if client_factory is None:
        from openai import OpenAI

        client_factory = OpenAI
    client = client_factory(api_key=tts.api_key, base_url=tts.base_url, max_retries=0, timeout=30.0)
    params: dict[str, Any] = {
        "model": tts.model,
        "voice": tts.voice,
        "input": text,
        "response_format": "pcm",
    }
    if tts.instructions:
        params["instructions"] = tts.instructions
    with client.audio.speech.with_streaming_response.create(**params) as response:
        pcm = response.read()
    return pcm, OPENAI_SAMPLE_RATE


def synthesize(request: dict[str, Any], api_key: str | None) -> bytes:
    tts = parse_tts_config(request.get("tts"), api_key=api_key)
    text = preview_text(str(request.get("language") or tts.language))
    pcm, sample_rate = openai_pcm(tts, text) if tts.provider == "openai" else kokoro_pcm(tts, text)
    if not pcm:
        raise RuntimeError("the voice returned no audio")
    data = wav_bytes(pcm, sample_rate)
    if len(data) > MAX_PREVIEW_BYTES:
        raise RuntimeError("the sample is too long")
    return data


def describe_error(exc: BaseException) -> str:
    """One line for the window. A provider's own message can echo part of the key: its status only."""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return f"HTTP {status}"
    text = str(exc).splitlines()[0] if str(exc) else ""
    return (f"{type(exc).__name__}: {text}" if text else type(exc).__name__)[:300]


def main() -> int:
    out = sys.stdout.buffer
    # Anything a library prints must not end up inside the WAV.
    sys.stdout = sys.stderr
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
        data = synthesize(
            request if isinstance(request, dict) else {},
            os.environ.get("OW_CONVERSATION_TTS_API_KEY"),
        )
    except Exception as exc:  # noqa: BLE001 - reported to OpenWhispr as one line
        sys.stderr.write(f"\n{describe_error(exc)}\n")
        sys.stderr.flush()
        return 2
    out.write(data)
    out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
