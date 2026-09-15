"""Choosing the microphone OpenWhispr is using, instead of PyAudio's default. Pure logic.

The app hands over the label Chromium gives the device ("Microphone (2- Stealth 600X Gen 3)").
PyAudio's default host API on Windows is MME, which truncates device names to 31 characters
("Microphone (2- Stealth 600X Gen"), so the two are rarely equal and a prefix match is the rule
rather than the exception.

Picking the wrong device is silent: the stream opens and delivers zeros, which is what a user
sees as "the voice agent does not hear me" while dictation works.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

MME_NAME_LIMIT = 31
# A truncated MME name is only a safe prefix if it is long enough to identify the device.
_MIN_PREFIX = 12


@dataclass(frozen=True)
class InputDevice:
    index: int
    name: str
    host_api: str = ""


@dataclass(frozen=True)
class DeviceChoice:
    index: int | None
    name: str
    status: str  # default | exact | truncated | partial | unmatched


def normalize(name: Any) -> str:
    return " ".join(str(name or "").split()).casefold()


def match_device(wanted: Any, devices: Iterable[InputDevice]) -> DeviceChoice:
    """The device a label points at, and how it was matched."""
    candidates = list(devices)
    target = normalize(wanted)
    if not target:
        return DeviceChoice(None, "", "default")

    for device in candidates:
        if normalize(device.name) == target:
            return DeviceChoice(device.index, device.name, "exact")

    # MME truncation: the sidecar sees a prefix of the label the app has.
    for device in candidates:
        name = normalize(device.name)
        if len(name) >= _MIN_PREFIX and target.startswith(name):
            return DeviceChoice(device.index, device.name, "truncated")

    # Chromium sometimes prefixes the label ("Default - Microphone (…)").
    for device in candidates:
        name = normalize(device.name)
        if len(name) >= _MIN_PREFIX and name in target:
            return DeviceChoice(device.index, device.name, "partial")

    return DeviceChoice(None, "", "unmatched")


def input_devices(py_audio: Any) -> list[InputDevice]:
    """Input devices of PyAudio's default host API (MME on Windows), in index order."""
    try:
        default_host = py_audio.get_default_host_api_info()["index"]
    except Exception:  # noqa: BLE001 - an unusable host API is not worth failing the session
        default_host = None
    devices: list[InputDevice] = []
    for index in range(py_audio.get_device_count()):
        info = py_audio.get_device_info_by_index(index)
        if not info.get("maxInputChannels"):
            continue
        if default_host is not None and info.get("hostApi") != default_host:
            continue
        devices.append(InputDevice(index=index, name=str(info.get("name") or ""), host_api=str(default_host)))
    return devices


def default_input_name(py_audio: Any) -> str:
    try:
        return str(py_audio.get_default_input_device_info()["name"])
    except Exception:  # noqa: BLE001 - a machine with no input device answers nothing
        return ""


def resolve_input_device(py_audio: Any, wanted: Any) -> DeviceChoice:
    """The device index to open, its name, and how the app's label was matched.

    An index of ``None`` means "let PyAudio use its default", which is also what an unmatched
    label falls back to — with a status the session reports, so the user learns that the
    microphone they chose in OpenWhispr is not the one being listened to.
    """
    choice = match_device(wanted, input_devices(py_audio))
    if choice.index is not None:
        return choice
    return DeviceChoice(None, default_input_name(py_audio), choice.status)
