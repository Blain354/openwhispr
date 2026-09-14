"""Development harness: recorded WAV turns instead of the microphone, and a silent speaker.

The input plays ``turnN.wav`` files in real time (20 ms frames), keeps feeding silence while the
bot answers, and moves to the next turn once the bot has stopped speaking for a while, as a person
would. The output consumes bot audio in real time without a sound device, so speaking frames and
latency measurements keep their real timing, and records it to ``bot-output.wav`` for listening.
"""

from __future__ import annotations

import asyncio
import re
import time
import wave
from pathlib import Path

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

FRAME_MS = 20
LEAD_SILENCE_S = 1.5
BOT_TAIL_S = 1.5
TURN_TIMEOUT_S = 90.0
_TURN_FILE = re.compile(r"^turn(\d+)\.wav$", re.IGNORECASE)


def load_turns(folder: str | Path) -> list[tuple[str, bytes]]:
    """``turn1.wav``, ``turn2.wav``... in numeric order; 16 kHz mono 16-bit PCM only."""
    entries = []
    for path in Path(folder).iterdir():
        match = _TURN_FILE.match(path.name)
        if match:
            entries.append((int(match.group(1)), path))
    turns = []
    for _, path in sorted(entries):
        with wave.open(str(path), "rb") as wav:
            if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
                raise ValueError(f"{path.name}: expected 16 kHz mono 16-bit PCM")
            turns.append((path.name, wav.readframes(wav.getnframes())))
    if not turns:
        raise ValueError(f"no turnN.wav file in {folder}")
    return turns


class WavInputTransport(BaseInputTransport):
    def __init__(self, turns: list[tuple[str, bytes]], params: TransportParams, **kwargs) -> None:
        super().__init__(params, **kwargs)
        self._turns = turns
        self._task: asyncio.Task | None = None
        self._bot_speaking = False
        self._bot_stops = 0
        self._last_bot_stop = 0.0

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)
        if self._task is None:
            self._task = self.create_task(self._play())

    async def stop(self, frame: EndFrame) -> None:
        await self._stop_playing()
        await super().stop(frame)

    async def cancel(self, frame: CancelFrame) -> None:
        await self._stop_playing()
        await super().cancel(frame)

    async def _stop_playing(self) -> None:
        if self._task is not None:
            await self.cancel_task(self._task)
            self._task = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            self._bot_stops += 1
            self._last_bot_stop = time.monotonic()

    async def _pace(self, pcm: bytes) -> None:
        chunk = int(self.sample_rate * FRAME_MS / 1000) * 2
        started = time.monotonic()
        for index, offset in enumerate(range(0, len(pcm), chunk), start=1):
            piece = pcm[offset : offset + chunk].ljust(chunk, b"\0")
            await self.push_audio_frame(
                InputAudioRawFrame(audio=piece, sample_rate=self.sample_rate, num_channels=1)
            )
            delay = started + index * FRAME_MS / 1000 - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)

    async def _silence(self, secs: float) -> None:
        await self._pace(bytes(int(self.sample_rate * secs) * 2))

    async def _play(self) -> None:
        await self._silence(LEAD_SILENCE_S)
        for name, pcm in self._turns:
            stops_before = self._bot_stops
            logger.info(f"[harness] playing {name}")
            await self._pace(pcm)
            deadline = time.monotonic() + TURN_TIMEOUT_S
            while time.monotonic() < deadline:
                answered = self._bot_stops > stops_before and not self._bot_speaking
                if answered and time.monotonic() - self._last_bot_stop >= BOT_TAIL_S:
                    break
                await self._silence(0.1)
            else:
                logger.warning(f"[harness] no answer to {name} within {TURN_TIMEOUT_S:.0f} s")
        logger.info("[harness] all turns played")
        while True:
            await self._silence(1.0)


class SilentOutputTransport(BaseOutputTransport):
    def __init__(self, params: TransportParams, *, record_path: Path | None = None, **kwargs) -> None:
        super().__init__(params, **kwargs)
        self._record_path = record_path
        self._recording: wave.Wave_write | None = None

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        if self._record_path is not None and self._recording is None:
            self._recording = wave.open(str(self._record_path), "wb")
            self._recording.setnchannels(1)
            self._recording.setsampwidth(2)
            self._recording.setframerate(self.sample_rate)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        if self._recording is not None:
            self._recording.writeframes(frame.audio)
        await asyncio.sleep(len(frame.audio) / (frame.sample_rate * frame.num_channels * 2))
        return True

    async def cleanup(self) -> None:
        await super().cleanup()
        if self._recording is not None:
            self._recording.close()
            self._recording = None


def wav_transport_factory(folder: str):
    turns = load_turns(folder)

    def factory():
        input_processor = WavInputTransport(turns, TransportParams(audio_in_enabled=True))
        output_processor = SilentOutputTransport(
            TransportParams(audio_out_enabled=True), record_path=Path(folder) / "bot-output.wav"
        )
        return input_processor, output_processor, lambda: None

    return factory
