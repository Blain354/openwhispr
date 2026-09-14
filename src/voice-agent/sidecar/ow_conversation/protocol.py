"""Mirror of src/voice-agent/shared/protocol.mjs for the Python side of the loopback WebSocket."""

from __future__ import annotations

import json
import time
from typing import Any

PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 1024 * 1024

SIDECAR_MESSAGE_TYPES = frozenset(
    {
        "hello",
        "ready",
        "state",
        "transcript.partial",
        "transcript.final",
        "assistant.delta",
        "assistant.final",
        "tool.call",
        "tool.cancel",
        "latency",
        "level",
        "warning",
        "error",
        "bye",
    }
)

APP_MESSAGE_TYPES = frozenset(
    {"session.config", "tool.result", "say", "interrupt", "mute", "update_tools", "shutdown", "ping"}
)


class ProtocolError(ValueError):
    pass


def encode(message_type: str, data: dict[str, Any] | None = None, *, id: str | None = None, turn: int | None = None) -> str:
    if message_type not in SIDECAR_MESSAGE_TYPES:
        raise ProtocolError(f"cannot send {message_type!r}")
    message: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": message_type,
        "ts": int(time.time() * 1000),
        "data": data or {},
    }
    if id is not None:
        message["id"] = id
    if turn is not None:
        message["turn"] = turn
    return json.dumps(message, ensure_ascii=False)


def decode(raw: str | bytes) -> dict[str, Any]:
    if isinstance(raw, bytes):
        raise ProtocolError("binary frames are not accepted")
    if len(raw) > MAX_MESSAGE_BYTES:
        raise ProtocolError("too-large")
    try:
        message = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProtocolError("invalid-json") from exc
    if not isinstance(message, dict):
        raise ProtocolError("not-object")
    if message.get("v") != PROTOCOL_VERSION:
        raise ProtocolError("version")
    if message.get("type") not in APP_MESSAGE_TYPES:
        raise ProtocolError("type")
    data = message.get("data", {})
    if not isinstance(data, dict):
        raise ProtocolError("data")
    if "id" in message and not isinstance(message["id"], str):
        raise ProtocolError("id")
    message["data"] = data
    return message
