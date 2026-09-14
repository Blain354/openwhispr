import asyncio

from pipecat.utils.text.base_text_aggregator import AggregationType

from ow_conversation.text_aggregator import FirstClauseTextAggregator


async def collect(aggregator, chunks):
    out = []
    for chunk in chunks:
        async for aggregation in aggregator.aggregate(chunk):
            out.append(aggregation.text)
    return out


def test_a_long_first_sentence_is_released_at_its_first_clause():
    async def scenario():
        aggregator = FirstClauseTextAggregator(aggregation_type=AggregationType.SENTENCE)
        out = await collect(
            aggregator,
            [
                "Il n'y a pas une seule capitale ",
                ": Canberra est la capitale fédérale, ",
                "mais chaque État a la sienne. ",
                "Voilà.",
            ],
        )
        assert out == [
            "Il n'y a pas une seule capitale :",
            "Canberra est la capitale fédérale, mais chaque État a la sienne.",
        ]
        rest = await aggregator.flush()
        assert rest is not None and rest.text.strip() == "Voilà."

    asyncio.run(scenario())


def test_short_clauses_wait_for_the_sentence_and_each_reply_starts_over():
    async def scenario():
        aggregator = FirstClauseTextAggregator(aggregation_type=AggregationType.SENTENCE)
        assert await collect(aggregator, ["Oui, bien sûr. ", "Ensuite"]) == ["Oui, bien sûr."]
        await aggregator.flush()
        out = await collect(aggregator, ["Une astuce pour mieux dormir est simple, garde ta chambre fraîche"])
        assert out == ["Une astuce pour mieux dormir est simple,"]

    asyncio.run(scenario())


def test_token_mode_is_untouched():
    async def scenario():
        aggregator = FirstClauseTextAggregator(aggregation_type=AggregationType.TOKEN)
        assert await collect(aggregator, ["Bonjour, ", "toi"]) == ["Bonjour, ", "toi"]

    asyncio.run(scenario())
