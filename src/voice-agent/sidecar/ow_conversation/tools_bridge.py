"""Round trip of tool calls between the voice LLM and the OpenWhispr session window.

The sidecar never runs a tool itself. A call goes to Electron as ``tool.call``; the session window
executes it (the main process asks for an on-screen confirmation when the tool needs one) and the
answer comes back as ``tool.result`` carrying the same id.
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

# Long enough for a 60 s on-screen confirmation plus a slow PowerShell script.
TOOL_RESULT_TIMEOUT_S = 180.0

# Tools whose execution waits for a button in a native dialog.
CONFIRMABLE_TOOLS = frozenset({"set_displays", "run_powershell", "delegate_task"})

# Spoken as soon as the model calls the tool, before the dialog is answered. A delegation is
# acknowledged once, here: the model is not asked to comment on an accepted delegation.
SPOKEN_ACKS = {"delegate_task": "D'accord, je lance ça en arrière-plan. Confirme à l'écran."}

SendFn = Callable[..., Awaitable[None]]


@dataclass(frozen=True)
class ToolOutcome:
    success: bool
    text: str


class ToolBridge:
    def __init__(self, send: SendFn, *, timeout_s: float = TOOL_RESULT_TIMEOUT_S) -> None:
        self._send = send
        self._timeout_s = timeout_s
        self._pending: dict[str, asyncio.Future[ToolOutcome]] = {}
        self._ids = itertools.count(1)
        self._background: set[asyncio.Task] = set()

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    async def _send_cancel(self, call_id: str, reason: str) -> None:
        try:
            await self._send("tool.cancel", {"reason": reason}, id=call_id)
        except Exception:  # noqa: BLE001 - the link may already be gone
            pass

    async def call(self, name: str, arguments: Any) -> ToolOutcome:
        call_id = f"tc-{next(self._ids)}"
        future: asyncio.Future[ToolOutcome] = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future
        try:
            await self._send(
                "tool.call", {"name": name, "arguments": arguments or {}}, id=call_id
            )
            return await asyncio.wait_for(future, self._timeout_s)
        except TimeoutError:
            await self._send_cancel(call_id, "timeout")
            return ToolOutcome(False, "The tool did not answer in time.")
        except asyncio.CancelledError:
            # Cancelled by pipecat (interruption or its own timeout): tell the executor, then let
            # the cancellation propagate as pipecat requires.
            task = asyncio.get_running_loop().create_task(self._send_cancel(call_id, "cancelled"))
            self._background.add(task)
            task.add_done_callback(self._background.discard)
            raise
        finally:
            self._pending.pop(call_id, None)

    def resolve(self, call_id: str | None, data: dict[str, Any]) -> bool:
        future = self._pending.get(call_id or "")
        if future is None or future.done():
            return False
        future.set_result(ToolOutcome(bool(data.get("success")), str(data.get("text") or "")))
        return True

    def cancel_all(self, reason: str = "The session ended.") -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_result(ToolOutcome(False, reason))
