"""Waiting for the user to finish a thought before answering. Pure logic (no pipecat import).

With a 0.6 s silence rule, a pause to think was a finished turn: the assistant answered half a
sentence. Pipecat can let the model decide instead: every reply starts with a marker and only
``●`` is spoken; ``◐`` (cut off mid-sentence) and ``○`` (thinking) keep the turn open in silence,
and what the user says next joins the same turn.

Measured with Qwen3.5 4B on 14 French utterances, twice each, prompts composed as the service
sends them (five of the utterances appear in no example):

- Pipecat's English instructions: 23 right decisions out of 28, never silent on a real request
  (0/10), spoke instead of waiting 5/18 — each time to ask for the missing detail. A silent
  verdict costs about 75 ms.
- A French translation with French examples: 18/28, spoke instead of waiting 10/18, including on
  « C'est, j'aimerais que tu lances ». So Pipecat's instructions are kept as they are.

One departure from Pipecat's defaults: an unfinished turn is never followed by a spoken nudge.
Pipecat re-prompts the model after 5 s / 10 s ("Go ahead, I'm listening"); the user asked for
silence, so the timer is pushed out of reach. Pipecat cancels it when the user speaks again.
"""

from __future__ import annotations

# A day: in practice, never.
NEVER_NUDGE_SECS = 24 * 3600.0


def system_prompt_for(
    base: str, *, turn_instructions: str = "", async_tool_instructions: str = ""
) -> str:
    """The system prompt exactly as the LLM service composes it for this app.

    Pipecat does not send the base prompt alone: ``LLMService._compose_system_instruction`` joins
    the base, the turn-completion instructions (when enabled) and the async-tool guidance (every
    session registers its tool handler with ``cancel_on_interruption=False``) with blank lines.
    The warm-up request must send the same text, or the model server's prompt cache misses and the
    first spoken turn pays for the whole prompt again.
    """
    return "\n\n".join(part for part in (base, turn_instructions, async_tool_instructions) if part)
