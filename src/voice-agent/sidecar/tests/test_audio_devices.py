"""Matching the app's microphone label against what PyAudio offers."""

from __future__ import annotations

from ow_conversation.audio_devices import (
    InputDevice,
    match_device,
    normalize,
    resolve_input_device,
)

MME = [
    InputDevice(0, "Microsoft Sound Mapper - Input"),
    InputDevice(1, "Microphone (2- Stealth 600X Gen"),
    InputDevice(2, "HD WebCam 2MP (HD WebCam 2MP)"),
    InputDevice(3, "Microphone (NVIDIA Broadcast)"),
]


def test_no_label_asks_for_the_default():
    choice = match_device("", MME)
    assert (choice.index, choice.status) == (None, "default")


def test_exact_label():
    choice = match_device("Microphone (NVIDIA Broadcast)", MME)
    assert (choice.index, choice.status) == (3, "exact")


def test_mme_truncates_the_name_to_31_characters():
    # What Chromium calls the device, against what MME can spell.
    choice = match_device("Microphone (2- Stealth 600X Gen 3)", MME)
    assert (choice.index, choice.status) == (1, "truncated")


def test_a_prefixed_label_still_matches():
    choice = match_device("Default - HD WebCam 2MP (HD WebCam 2MP)", MME)
    assert (choice.index, choice.status) == (2, "partial")


def test_case_and_spacing_do_not_matter():
    choice = match_device("  microphone   (nvidia broadcast)  ", MME)
    assert choice.index == 3


def test_an_unplugged_microphone_is_reported_not_guessed():
    choice = match_device("Microphone (Blue Yeti)", MME)
    assert (choice.index, choice.status) == (None, "unmatched")


def test_a_short_device_name_never_swallows_another_label():
    devices = [InputDevice(0, "Mic"), InputDevice(1, "Microphone (2- Stealth 600X Gen")]
    assert match_device("Microphone (2- Stealth 600X Gen 3)", devices).index == 1


def test_normalize_collapses_whitespace():
    assert normalize("  A   b\tC ") == "a b c"


class FakePyAudio:
    """The three calls audio_devices makes, and nothing else."""

    def __init__(self, devices, default_index=1, host_api=0):
        self._devices = devices
        self._default_index = default_index
        self._host_api = host_api

    def get_default_host_api_info(self):
        return {"index": self._host_api}

    def get_device_count(self):
        return len(self._devices)

    def get_device_info_by_index(self, index):
        return self._devices[index]

    def get_default_input_device_info(self):
        return self._devices[self._default_index]


def _info(name, *, host_api=0, inputs=1):
    return {"name": name, "hostApi": host_api, "maxInputChannels": inputs}


def test_resolve_keeps_only_the_default_host_api():
    py_audio = FakePyAudio(
        [
            _info("Microphone (2- Stealth 600X Gen"),
            _info("Microphone (2- Stealth 600X Gen 3)", host_api=2),
            _info("Speakers", inputs=0),
        ],
        default_index=0,
    )
    choice = resolve_input_device(py_audio, "Microphone (2- Stealth 600X Gen 3)")
    # The full name belongs to another host API: the MME entry is the one that can be opened.
    assert (choice.index, choice.status) == (0, "truncated")


def test_resolve_falls_back_to_the_default_device_and_names_it():
    py_audio = FakePyAudio([_info("Microphone (NVIDIA Broadcast)")], default_index=0)
    choice = resolve_input_device(py_audio, "Microphone (Blue Yeti)")
    assert choice.index is None
    assert choice.status == "unmatched"
    assert choice.name == "Microphone (NVIDIA Broadcast)"
