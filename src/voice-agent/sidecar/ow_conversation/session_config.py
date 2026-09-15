"""The ``session.config`` message from OpenWhispr, validated. Pure logic (no pipecat import)."""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

MAX_TOOLS = 12
# Same budget as runtime.js: the app, project names and the user's dictionary. faster-whisper
# keeps the first 223 tokens of it.
HOTWORDS_MAX_CHARS = 1200
_TOOL_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_LOOPBACK_PREFIXES = ("http://127.0.0.1:", "http://localhost:", "http://[::1]:")


# pipecat 1.10's OpenAITTSService accepts these voices (openai/tts.py VALID_VOICES).
OPENAI_TTS_VOICES = frozenset(
    {"alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"}
)
TTS_INSTRUCTIONS_MAX_CHARS = 500
_KOKORO_VOICE = re.compile(r"^[a-z]{2}_[a-z]+$")
_KOKORO_LANGUAGES = frozenset({"fr-fr", "en-us", "en-gb"})


@dataclass(frozen=True)
class TtsConfig:
    """The voice that reads the replies: Kokoro on this computer, or OpenAI's speech endpoint."""

    provider: str
    voice: str
    language: str = "fr-fr"
    speed: float = 1.0
    model_path: str = ""
    voices_path: str = ""
    model: str = ""
    instructions: str = ""
    base_url: str = ""
    api_key: str = field(default="", repr=False)


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
    wait_for_complete_turns: bool
    whisper_model: str
    tts: TtsConfig


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


def is_private_host(hostname: str) -> bool:
    """Plain HTTP is tolerated only inside the user's own network: the app's isPrivateHost rule."""
    host = (hostname or "").lower().strip("[]")
    if host in ("localhost", "0.0.0.0", "::1") or host.endswith((".local", ".ts.net")):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.version == 4:
        a, b = ip.packed[0], ip.packed[1]
        return (
            a in (127, 10)
            or (a == 192 and b == 168)
            or (a == 172 and 16 <= b <= 31)
            or (a == 100 and 64 <= b <= 127)  # RFC 6598, used by Tailscale
            or (a == 169 and b == 254)
        )
    return ip.is_link_local or host.startswith(("fc", "fd"))


def is_reachable_remote(url: str) -> bool:
    """HTTPS anywhere, plain HTTP only to a private host."""
    parsed = urlparse(url)
    if parsed.scheme == "https":
        return True
    return parsed.scheme == "http" and is_private_host(parsed.hostname or "")


def tts_speed(value: Any) -> float:
    """Kokoro's speech rate, within the 0.5-2.0 band it accepts."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 1.0
    if number != number:  # NaN
        return 1.0
    return min(2.0, max(0.5, number))


def parse_tts_config(raw: Any, *, api_key: str | None = None) -> TtsConfig:
    """The voice of a session. An online voice needs HTTPS (or plain HTTP inside the user's network),
    a known voice and its key; Kokoro needs its two model files."""
    data = raw if isinstance(raw, dict) else {}
    provider = str(data.get("provider") or "kokoro")
    if provider == "openai":
        base_url = str(data.get("baseURL") or "").rstrip("/")
        if not is_reachable_remote(base_url):
            raise ValueError("an online voice must be reached over HTTPS, or plain HTTP on a private network")
        voice = str(data.get("voice") or "")
        if voice not in OPENAI_TTS_VOICES:
            raise ValueError(f"unknown OpenAI voice {voice!r}")
        if not api_key:
            raise ValueError("an online voice needs its API key")
        return TtsConfig(
            provider="openai",
            voice=voice,
            model=str(data.get("model") or "gpt-4o-mini-tts"),
            instructions=str(data.get("instructions") or "").strip()[:TTS_INSTRUCTIONS_MAX_CHARS],
            base_url=base_url,
            api_key=api_key,
        )
    if provider != "kokoro":
        raise ValueError(f"unknown voice provider {provider!r}")
    model_path = str(data.get("modelPath") or "")
    voices_path = str(data.get("voicesPath") or "")
    if not model_path or not voices_path:
        raise ValueError("missing Kokoro model paths")
    voice = str(data.get("voice") or "ff_siwis")
    if not _KOKORO_VOICE.match(voice):
        raise ValueError(f"invalid Kokoro voice {voice!r}")
    language = str(data.get("language") or "fr-fr").lower()
    return TtsConfig(
        provider="kokoro",
        voice=voice,
        language=language if language in _KOKORO_LANGUAGES else "fr-fr",
        speed=tts_speed(data.get("speed")),
        model_path=model_path,
        voices_path=voices_path,
    )


def parse_session_config(
    data: dict[str, Any], *, api_key: str | None = None, tts_api_key: str | None = None
) -> SessionConfig:
    llm = data.get("llm") if isinstance(data.get("llm"), dict) else {}
    base_url = str(llm.get("baseURL") or "").rstrip("/")
    local = bool(llm.get("local"))
    if local and not base_url.startswith(_LOOPBACK_PREFIXES):
        raise ValueError("a local model must be served on the loopback interface")
    if not local and not is_reachable_remote(base_url):
        raise ValueError("a remote model must be served over HTTPS, or plain HTTP on a private network")
    if isinstance(data.get("tts"), dict):
        tts_raw = data["tts"]
    else:
        # An app from before the voice picker sends its Kokoro voice as `kokoro`.
        legacy = data.get("kokoro") if isinstance(data.get("kokoro"), dict) else {}
        tts_raw = {**legacy, "provider": "kokoro"}
    tts = parse_tts_config(tts_raw, api_key=tts_api_key)
    return SessionConfig(
        llm_base_url=base_url,
        llm_model=str(llm.get("model") or "local"),
        llm_local=local,
        llm_api_key=api_key or "",
        system_prompt=str(data.get("systemPrompt") or ""),
        tools=tuple(tool_specs(data.get("tools"))),
        stt_language=stt_language_code(data.get("sttLanguage")),
        hotwords=str(data.get("hotwords") or "")[:HOTWORDS_MAX_CHARS],
        barge_in="interrupt" if data.get("bargeIn") == "interrupt" else "mute",
        input_device=str(data.get("inputDevice") or "")[:200],
        vad_min_volume=vad_min_volume(data.get("vadMinVolume")),
        # On unless the app says otherwise: an older app sends nothing and still gets it.
        wait_for_complete_turns=data.get("waitForCompleteTurns") is not False,
        whisper_model=str(data.get("whisperModel") or "deepdml/faster-whisper-large-v3-turbo-ct2"),
        tts=tts,
    )
