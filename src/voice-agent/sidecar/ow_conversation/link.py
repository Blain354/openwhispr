"""Loopback WebSocket link from the sidecar to the OpenWhispr main process.

Electron hosts the server on 127.0.0.1 and accepts one client presenting the per-launch token as a
Bearer header, without an Origin header. Everything crossing the link is a protocol envelope; a
malformed message from Electron is logged and skipped, never acted on.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from . import protocol

Handler = Callable[[dict[str, Any]], Awaitable[None] | None]


class Link:
    def __init__(self, url: str, token: str) -> None:
        if not url.startswith("ws://127.0.0.1:"):
            raise ValueError("the conversation link only connects to the loopback interface")
        if not token:
            raise ValueError("missing OW_CONVERSATION_TOKEN")
        self._url = url
        self._token = token
        self._ws: ClientConnection | None = None

    @property
    def is_open(self) -> bool:
        return self._ws is not None

    async def open(self, timeout_s: float = 10.0) -> None:
        self._ws = await connect(
            self._url,
            additional_headers={"Authorization": f"Bearer {self._token}"},
            max_size=protocol.MAX_MESSAGE_BYTES,
            open_timeout=timeout_s,
            ping_interval=20,
            ping_timeout=20,
        )

    async def send(
        self,
        message_type: str,
        data: dict[str, Any] | None = None,
        *,
        id: str | None = None,
        turn: int | None = None,
    ) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(protocol.encode(message_type, data, id=id, turn=turn))
        except ConnectionClosed:
            self._ws = None

    async def _next_message(self) -> dict[str, Any] | None:
        ws = self._ws
        if ws is None:
            return None
        while True:
            try:
                raw = await ws.recv()
            except ConnectionClosed:
                self._ws = None
                return None
            try:
                return protocol.decode(raw)
            except protocol.ProtocolError as exc:
                logger.warning(f"Ignoring an invalid message from OpenWhispr: {exc}")

    async def wait_for(self, message_type: str, timeout_s: float) -> dict[str, Any]:
        """Wait for one message type during startup; anything else received meanwhile is dropped."""

        async def scan() -> dict[str, Any]:
            while True:
                message = await self._next_message()
                if message is None:
                    raise ConnectionError("OpenWhispr closed the conversation link")
                if message["type"] == message_type:
                    return message

        return await asyncio.wait_for(scan(), timeout_s)

    async def run(self, handlers: dict[str, Handler]) -> None:
        """Dispatch messages until the link closes. A failing handler never stops the loop."""
        while True:
            message = await self._next_message()
            if message is None:
                return
            handler = handlers.get(message["type"])
            if handler is None:
                continue
            try:
                result = handler(message)
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:  # noqa: BLE001
                logger.exception(f"Handler for {message['type']} failed: {exc}")

    async def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            await ws.close()
