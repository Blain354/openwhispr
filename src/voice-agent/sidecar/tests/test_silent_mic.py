"""The warning raised when the microphone that was opened delivers nothing."""

from __future__ import annotations

import struct

from ow_conversation.bot import SILENT_MIC_SECS, BridgeObserver


def observer(events):
    return BridgeObserver(
        lambda event, data=None: events.append((event, data)),
        input_processor=object(),
        output_processor=object(),
        user_aggregator=object(),
        llm=object(),
        device_name="Microphone (2- Stealth 600X Gen",
    )


SILENCE = b"\x00\x00" * 320
SPEECH = struct.pack("<320h", *([12000, -12000] * 160))


def test_a_silent_microphone_is_reported_once():
    events = []
    watcher = observer(events)
    watcher._watch_for_silence(SILENCE, 0.0)
    watcher._watch_for_silence(SILENCE, SILENT_MIC_SECS / 2)
    assert events == []

    watcher._watch_for_silence(SILENCE, SILENT_MIC_SECS + 0.1)
    assert events == [
        ("warning", {"code": "micSilent", "device": "Microphone (2- Stealth 600X Gen"})
    ]

    watcher._watch_for_silence(SILENCE, SILENT_MIC_SECS * 3)
    assert len(events) == 1


def test_a_microphone_that_carried_sound_is_not_reported():
    events = []
    watcher = observer(events)
    watcher._watch_for_silence(SILENCE, 0.0)
    watcher._watch_for_silence(SPEECH, 1.0)
    watcher._watch_for_silence(SILENCE, SILENT_MIC_SECS + 0.1)
    assert events == []


def test_nothing_is_reported_once_the_user_has_been_heard():
    events = []
    watcher = observer(events)
    watcher._watch_for_silence(SILENCE, 0.0)
    watcher._heard_user = True
    watcher._watch_for_silence(SILENCE, SILENT_MIC_SECS + 0.1)
    assert events == []
