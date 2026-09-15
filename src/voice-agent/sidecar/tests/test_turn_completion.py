"""Waiting for a finished turn: the strategy, and the prompt the model really receives."""

from __future__ import annotations

import asyncio

from pipecat.processors.aggregators.async_tool_messages import ASYNC_TOOL_INSTRUCTIONS
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_turn_completion_mixin import USER_TURN_COMPLETION_INSTRUCTIONS
from pipecat.turns.user_turn_strategies import FilterIncompleteUserTurnStrategies

from ow_conversation.bot import LocalOpenAILLMService, composed_system_prompt, turn_strategies
from ow_conversation.session_config import parse_session_config
from ow_conversation.turn_completion import NEVER_NUDGE_SECS, system_prompt_for

KOKORO = {"modelPath": "C:/k/kokoro-v1.0.onnx", "voicesPath": "C:/k/voices-v1.0.bin"}


def config(**extra):
    return parse_session_config(
        {
            "llm": {"baseURL": "http://127.0.0.1:8222/v1", "model": "m", "local": True},
            "systemPrompt": "Réponds brièvement.",
            "kokoro": KOKORO,
            **extra,
        }
    )


def test_the_prompt_is_base_then_turn_instructions_then_async_tool_guidance():
    assert system_prompt_for("Base.", async_tool_instructions="A") == "Base.\n\nA"
    assert (
        system_prompt_for("Base.", turn_instructions="T", async_tool_instructions="A")
        == "Base.\n\nT\n\nA"
    )


def test_the_warm_up_sends_exactly_what_pipecat_composes():
    cfg = config()
    llm = LocalOpenAILLMService(
        api_key="sk-local",
        base_url=cfg.llm_base_url,
        settings=OpenAILLMService.Settings(model=cfg.llm_model, system_instruction=cfg.system_prompt),
    )

    async def handler(_params):
        return None

    llm.register_function(None, handler, cancel_on_interruption=False)
    asyncio.run(
        llm._update_settings(
            LLMSettings(
                filter_incomplete_user_turns=True,
                user_turn_completion_config=turn_strategies(cfg).config,
            )
        )
    )
    assert llm._settings.system_instruction == composed_system_prompt(cfg)


def test_the_prompt_carries_pipecats_turn_instructions_and_the_async_guidance():
    prompt = composed_system_prompt(config())
    assert prompt.startswith("Réponds brièvement.")
    assert USER_TURN_COMPLETION_INSTRUCTIONS in prompt
    assert ASYNC_TOOL_INSTRUCTIONS in prompt


def test_waiting_is_on_by_default_with_pipecats_instructions_and_no_nudge():
    strategies = turn_strategies(config())
    assert isinstance(strategies, FilterIncompleteUserTurnStrategies)
    # Pipecat's own instructions: measured better than a French translation (turn_completion.py).
    assert strategies.config.instructions is None
    assert strategies.config.incomplete_short_timeout == NEVER_NUDGE_SECS
    assert strategies.config.incomplete_long_timeout == NEVER_NUDGE_SECS
    assert NEVER_NUDGE_SECS >= 3600


def test_waiting_can_be_turned_off():
    cfg = config(waitForCompleteTurns=False)
    assert cfg.wait_for_complete_turns is False
    assert not isinstance(turn_strategies(cfg), FilterIncompleteUserTurnStrategies)
    prompt = composed_system_prompt(cfg)
    assert USER_TURN_COMPLETION_INSTRUCTIONS not in prompt
    assert ASYNC_TOOL_INSTRUCTIONS in prompt
