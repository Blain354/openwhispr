"""Entry point: ``python -m ow_conversation --ws-url ws://127.0.0.1:PORT --device cuda``.

Startup order matters: connect and say hello (so OpenWhispr knows the process is alive), receive
the session configuration, prepare the CUDA DLL path, then import pipecat and load the models, and
report ``ready`` once the pipeline has started and the microphone is open.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

from loguru import logger

from .cuda_env import prepare_cuda_path
from .link import Link
from .session_config import parse_session_config

CONFIG_TIMEOUT_S = 30.0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="ow_conversation")
    parser.add_argument("--ws-url", required=True)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument(
        "--wav-input",
        help="development harness: play the WAV turns of this folder instead of using the microphone",
    )
    return parser.parse_args(argv)


async def run(args: argparse.Namespace) -> int:
    link = Link(args.ws_url, os.environ.get("OW_CONVERSATION_TOKEN", ""))
    await link.open()
    await link.send("hello", {"protocol": 1, "pid": os.getpid(), "device": args.device})
    try:
        message = await link.wait_for("session.config", CONFIG_TIMEOUT_S)
        cfg = parse_session_config(
            message["data"], api_key=os.environ.get("OW_CONVERSATION_LLM_API_KEY")
        )
        started = time.perf_counter()
        from . import bot  # imports faster_whisper: after prepare_cuda_path()

        stt, llm, tts = bot.build_services(cfg, args.device)
        load_ms = round((time.perf_counter() - started) * 1000)
    except Exception as exc:  # noqa: BLE001 - reported to OpenWhispr, then exit
        logger.exception("Voice engine failed to start")
        await link.send("error", {"message": f"voice engine failed to start: {exc}", "fatal": True})
        await link.close()
        return 2

    transport_factory = None
    if args.wav_input:
        from .wav_input import wav_transport_factory

        transport_factory = wav_transport_factory(args.wav_input)
    voice_bot = bot.VoiceBot(
        cfg,
        link,
        stt,
        llm,
        tts,
        transport_factory=transport_factory,
        ready_data={"device": args.device, "loadMs": load_ms, "wavInput": bool(args.wav_input)},
    )
    await voice_bot.run()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logger.remove()
    logger.add(sys.stderr, level=os.environ.get("OW_CONVERSATION_LOG_LEVEL", "INFO"))
    if args.device == "cuda":
        prepare_cuda_path()
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
