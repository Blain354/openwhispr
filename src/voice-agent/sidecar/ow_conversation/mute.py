"""User mute strategy of a voice session: while the bot speaks, a short tail after, or on demand.

Without echo cancellation, the speaker would feed the bot's own voice back into Whisper. The user
aggregator re-evaluates strategies on every frame it receives (about every 20 ms with microphone
audio), so the tail is checked against a monotonic clock and needs no timer.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, Frame
from pipecat.turns.user_mute import BaseUserMuteStrategy


class SessionMuteStrategy(BaseUserMuteStrategy):
    def __init__(
        self,
        *,
        tail_secs: float = 0.8,
        mute_while_bot_speaks: bool = True,
        clock: Callable[[], float] = time.monotonic,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._tail_secs = tail_secs
        self._mute_while_bot_speaks = mute_while_bot_speaks
        self._clock = clock
        self._bot_speaking = False
        self._release_at = 0.0
        self.manual_mute = False

    async def process_frame(self, frame: Frame) -> bool:
        await super().process_frame(frame)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            self._release_at = self._clock() + self._tail_secs
        if self.manual_mute:
            return True
        if not self._mute_while_bot_speaks:
            return False
        return self._bot_speaking or self._clock() < self._release_at
