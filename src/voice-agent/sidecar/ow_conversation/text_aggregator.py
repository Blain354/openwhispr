"""TTS text aggregation that releases the first clause of a reply early.

Kokoro synthesizes a whole aggregate before any audio. With sentence aggregation, a 20-word first
sentence held the first audio back by 1.2 s in the five-turn run. The first aggregate of each reply
is therefore cut at the first comma, colon or semicolon once it is long enough to sound natural;
the rest of the reply is aggregated by sentence as usual.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from pipecat.utils.text.base_text_aggregator import Aggregation, AggregationType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

CLAUSE_BREAKS = frozenset(",:;")
MIN_FIRST_CLAUSE_CHARS = 24


class FirstClauseTextAggregator(SimpleTextAggregator):
    def __init__(self, *, min_chars: int = MIN_FIRST_CLAUSE_CHARS, **kwargs) -> None:
        super().__init__(**kwargs)
        self._min_chars = min_chars
        self._first_released = False

    async def aggregate(self, text: str) -> AsyncIterator[Aggregation]:
        if self._aggregation_type == AggregationType.TOKEN:
            async for aggregation in super().aggregate(text):
                yield aggregation
            return
        for char in text:
            self._text += char
            result = await self._check_sentence_with_lookahead(char)
            if (
                result is None
                and not self._first_released
                and char in CLAUSE_BREAKS
                and len(self._text.strip()) >= self._min_chars
            ):
                result = Aggregation(text=self._text.strip(" "), type=AggregationType.SENTENCE)
                self._text = ""
                self._needs_lookahead = False
            if result is not None:
                self._first_released = True
                yield result

    async def flush(self) -> Aggregation | None:
        self._first_released = False
        return await super().flush()

    async def handle_interruption(self) -> None:
        self._first_released = False
        await super().handle_interruption()

    async def reset(self) -> None:
        self._first_released = False
        await super().reset()
