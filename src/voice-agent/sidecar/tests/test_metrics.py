import numpy as np

from ow_conversation.metrics import LevelMeter, latency_payload, rms_level


def pcm(value: int, n: int = 320) -> bytes:
    return np.full(n, value, dtype=np.int16).tobytes()


def test_rms_level_is_bounded_and_monotonic():
    assert rms_level(b"") == 0.0
    assert rms_level(pcm(0)) == 0.0
    quiet, loud = rms_level(pcm(500)), rms_level(pcm(16000))
    assert 0 < quiet < loud <= 1.0
    assert rms_level(pcm(32767)) == 1.0


def test_level_updates_are_throttled():
    meter = LevelMeter(interval_s=0.05)
    assert meter.update(pcm(1000), now=1.00) is not None
    assert meter.update(pcm(1000), now=1.02) is None
    assert meter.update(pcm(1000), now=1.05) is not None


def test_latency_payload_names_the_main_stages():
    payload = latency_payload(
        1.2345,
        [("transcription", 0.25), ("llm_inference", 0.5), ("speech_synthesis", 0.3), ("llm_inference", 0.1)],
    )
    assert payload == {
        "userBotMs": 1234,
        "stages": {"transcription": 250, "llm_inference": 600, "speech_synthesis": 300},
        "sttMs": 250,
        "llmMs": 600,
        "ttsMs": 300,
    }
