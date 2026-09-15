"""The ``session.config`` message from OpenWhispr, validated. Pure logic (no pipecat import)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

MAX_TOOLS = 12
_TOOL_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_LOOPBACK_PREFIXES = ("http://127.0.0.1:", "http://localhost:", "http://[::1]:")


@dataclass(frozen=True)
class SessionConfig:
    llm_base_url: str
    llm_model: str
    llm_local: bool
    llm_api_key: str
    system_prompt: str
    tools: tuple[dict[str, Any], ...]
    stt_language: str | None
    hotwords: str
    barge_in: str
    input_device: str
    vad_min_volume: float
    whisper_model: str
    kokoro_model_path: str
    kokoro_voices_path: str
    kokoro_voice: str
    kokoro_language: str


def stt_language_code(value: Any) -> str | None:
    """``auto`` (or nothing) lets Whisper detect the language; ``fr-CA`` becomes ``fr``."""
    text = str(value or "auto").strip().lower()
    if text in ("", "auto"):
        return None
    return text.split("-")[0]


# Pipecat's default is 0.6 (about -50 LUFS): a quiet headset never reaches it.
DEFAULT_VAD_MIN_VOLUME = 0.4


def vad_min_volume(value: Any) -> float:
    """Loudness floor for speech, 0..1 on Pipecat's -110..-10 LUFS scale, clamped to a sane band."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_VAD_MIN_VOLUME
    if number != number:  # NaN
        return DEFAULT_VAD_MIN_VOLUME
    return min(0.9, max(0.1, number))


def tool_specs(tools: Any) -> list[dict[str, Any]]:
    """Normalize tool schemas for the LLM: valid names only, no duplicates, at most MAX_TOOLS."""
    specs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tool in tools if isinstance(tools, list) else []:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if not isinstance(name, str) or not _TOOL_NAME.match(name) or name in seen:
            continue
        parameters = tool.get("parameters") if isinstance(tool.get("parameters"), dict) else {}
        properties = parameters.get("properties")
        required = parameters.get("required")
        specs.append(
            {
                "name": name,
                "description": str(tool.get("description") or ""),
                "properties": properties if isinstance(properties, dict) else {},
                "required": [r for r in required if isinstance(r, str)]
                if isinstance(required, list)
                else [],
            }
        )
        seen.add(name)
        if len(specs) == MAX_TOOLS:
            break
    return specs


def parse_session_config(data: dict[str, Any], *, api_key: str | None = None) -> SessionConfig:
    llm = data.get("llm") if isinstance(data.get("llm"), dict) else {}
    base_url = str(llm.get("baseURL") or "").rstrip("/")
    local = bool(llm.get("local"))
    if local and not base_url.startswith(_LOOPBACK_PREFIXES):
        raise ValueError("a local model must be served on the loopback interface")
    if not local and not base_url.startswith("https://") and not base_url.startswith(_LOOPBACK_PREFIXES):
        raise ValueError("a remote model must be served over HTTPS")
    kokoro = data.get("kokoro") if isinstance(data.get("kokoro"), dict) else {}
    model_path = str(kokoro.get("modelPath") or "")
    voices_path = str(kokoro.get("voicesPath") or "")
    if not model_path or not voices_path:
        raise ValueError("missing Kokoro model paths")
    return SessionConfig(
        llm_base_url=base_url,
        llm_model=str(llm.get("model") or "local"),
        llm_local=local,
        llm_api_key=api_key or "",
        system_prompt=str(data.get("systemPrompt") or ""),
        tools=tuple(tool_specs(data.get("tools"))),
        stt_language=stt_language_code(data.get("sttLanguage")),
        hotwords=str(data.get("hotwords") or "")[:300],
        barge_in="interrupt" if data.get("bargeIn") == "interrupt" else "mute",
        input_device=str(data.get("inputDevice") or "")[:200],
        vad_min_volume=vad_min_volume(data.get("vadMinVolume")),
        whisper_model=str(data.get("whisperModel") or "deepdml/faster-whisper-large-v3-turbo-ct2"),
        kokoro_model_path=model_path,
        kokoro_voices_path=voices_path,
        kokoro_voice=str(kokoro.get("voice") or "ff_siwis"),
        kokoro_language=str(kokoro.get("language") or "fr-fr"),
    )
