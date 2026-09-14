"""Microphone level and turn latency payloads sent to OpenWhispr. Pure logic."""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np

# Pipecat's LatencyBreakdown contribution keys worth a dedicated field.
_STAGE_FIELDS = {
    "transcription": "sttMs",
    "llm_inference": "llmMs",
    "speech_synthesis": "ttsMs",
    "llm_tool_call": "toolMs",
}


def rms_level(pcm16: bytes) -> float:
    """0..1 level of 16-bit PCM, square-rooted so quiet speech still moves the orb."""
    if len(pcm16) < 2:
        return 0.0
    samples = np.frombuffer(pcm16[: len(pcm16) // 2 * 2], dtype=np.int16).astype(np.float32)
    rms = float(np.sqrt(np.mean(samples * samples))) / 32768.0
    return round(min(1.0, rms**0.5), 3)


class LevelMeter:
    """Throttles level updates to one per ``interval_s``."""

    def __init__(self, interval_s: float = 0.05) -> None:
        self._interval_s = interval_s
        self._next_at = 0.0

    def update(self, pcm16: bytes, now: float) -> float | None:
        if now < self._next_at:
            return None
        self._next_at = now + self._interval_s
        return rms_level(pcm16)


def latency_payload(total_secs: float, contributions: Iterable[tuple[str, float]]) -> dict:
    stages: dict[str, int] = {}
    for key, secs in contributions:
        stages[key] = stages.get(key, 0) + round(secs * 1000)
    payload: dict = {"userBotMs": round(total_secs * 1000), "stages": stages}
    for key, field in _STAGE_FIELDS.items():
        if key in stages:
            payload[field] = stages[key]
    return payload
