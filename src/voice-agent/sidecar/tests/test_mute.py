import asyncio

from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, InputAudioRawFrame

from ow_conversation.mute import SessionMuteStrategy


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def mic() -> InputAudioRawFrame:
    return InputAudioRawFrame(audio=bytes(640), sample_rate=16000, num_channels=1)


def test_muted_while_the_bot_speaks_and_for_the_tail_after():
    async def scenario():
        clock = Clock()
        strategy = SessionMuteStrategy(tail_secs=0.8, clock=clock)
        assert await strategy.process_frame(mic()) is False
        assert await strategy.process_frame(BotStartedSpeakingFrame()) is True
        clock.now += 5
        assert await strategy.process_frame(mic()) is True
        assert await strategy.process_frame(BotStoppedSpeakingFrame()) is True
        clock.now += 0.79
        assert await strategy.process_frame(mic()) is True
        clock.now += 0.02
        assert await strategy.process_frame(mic()) is False

    asyncio.run(scenario())


def test_manual_mute_and_interrupt_mode():
    async def scenario():
        clock = Clock()
        strategy = SessionMuteStrategy(mute_while_bot_speaks=False, clock=clock)
        assert await strategy.process_frame(BotStartedSpeakingFrame()) is False
        strategy.manual_mute = True
        assert await strategy.process_frame(mic()) is True
        strategy.manual_mute = False
        assert await strategy.process_frame(mic()) is False

    asyncio.run(scenario())
