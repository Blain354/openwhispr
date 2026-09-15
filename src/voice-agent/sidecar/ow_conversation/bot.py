"""Voice pipeline of the Conversation mode sidecar (pipecat-ai 1.10.0).

microphone -> Whisper -> user aggregator (Silero VAD, mute strategies) -> interrupt gate -> LLM ->
Kokoro -> speaker -> assistant aggregator

Import this module only after ``cuda_env.prepare_cuda_path()``: pipecat's Whisper service imports
faster_whisper, and with it ctranslate2, at import time.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncGenerator, Callable
from functools import partial
from typing import Any

import numpy as np
from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    ErrorFrame,
    Frame,
    FunctionCallsStartedFrame,
    InputAudioRawFrame,
    LLMFullResponseStartFrame,
    LLMSetToolsFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.observers.user_bot_latency_observer import LatencyBreakdown, UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.async_tool_messages import ASYNC_TOOL_INSTRUCTIONS
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.turns.user_mute import FunctionCallUserMuteStrategy
from pipecat.turns.user_start import TranscriptionUserTurnStartStrategy, VADUserTurnStartStrategy
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_completion_mixin import UserTurnCompletionConfig
from pipecat.turns.user_turn_strategies import FilterIncompleteUserTurnStrategies, UserTurnStrategies
from pipecat.utils.time import time_now_iso8601
from pipecat.utils.types import assert_given
from pipecat.workers.runner import WorkerRunner

from .link import Link
from .audio_devices import DeviceChoice, resolve_input_device
from .metrics import LevelMeter, latency_payload, rms_level
from .mute import SessionMuteStrategy
from .session_config import SessionConfig
from .text_aggregator import FirstClauseTextAggregator
from .tools_bridge import CONFIRMABLE_TOOLS, SPOKEN_ACKS, ToolBridge
from .turn_completion import NEVER_NUDGE_SECS, system_prompt_for

CONFIRM_PHRASE = "Confirme à l'écran."
NO_SPEECH_PROB = 0.6
# Silence after the VAD stop before the turn ends. 0.6 s measured ~320 ms of turn-end latency.
TURN_STOP_TIMEOUT_SECS = 0.4
TOOL_TIMEOUT_SECS = 200.0
# A microphone that streams zeros: reported once, after this long without a sound above the floor.
SILENT_MIC_SECS = 12.0
SILENT_MIC_LEVEL = 0.01

# (input processor, output processor, close callback)
TransportFactory = Callable[[], tuple[FrameProcessor, FrameProcessor, Callable[[], None]]]


class ThreadedWhisperSTTService(WhisperSTTService):
    """Runs the whole decode in a worker thread.

    Upstream threads only ``transcribe()``, but faster-whisper decodes lazily while its segment
    generator is consumed, which upstream does on the event loop (whisper/stt.py:427-440) and which
    would stall microphone capture and playback. Also records the detected language.
    """

    last_language: str | None = None
    last_language_probability: float | None = None

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        if not self._model:
            yield ErrorFrame("Whisper model not available")
            return
        await self.start_processing_metrics()
        audio_float = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
        language = assert_given(self._settings.language)
        hotwords = assert_given(self._settings.hotwords)
        threshold = assert_given(self._settings.no_speech_prob)
        model = self._model

        def decode() -> tuple[str, Any]:
            # Short voice turns: greedy decoding, no timestamps, no conditioning on earlier text.
            segments, info = model.transcribe(
                audio_float,
                language=language,
                hotwords=hotwords,
                beam_size=1,
                without_timestamps=True,
                condition_on_previous_text=False,
            )
            kept = [
                s.text.strip()
                for s in segments
                if threshold is not None and s.no_speech_prob < threshold
            ]
            return " ".join(t for t in kept if t).strip(), info

        text, info = await asyncio.to_thread(decode)
        await self.stop_processing_metrics()
        self.last_language = getattr(info, "language", None)
        self.last_language_probability = getattr(info, "language_probability", None)
        if text:
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), language)

    def warm_up(self) -> None:
        """The first CUDA inference loads cuBLAS and cuDNN: fail here, before reporting ready."""
        silence = np.zeros(16000, dtype=np.float32)
        segments, _ = self._model.transcribe(silence, language="fr")
        list(segments)


class LocalOpenAILLMService(OpenAILLMService):
    # llama.cpp chat templates have no "developer" role (base_llm.py:87-94).
    supports_developer_role = False


class InterruptGate(FrameProcessor):
    """Pass-through placed after the user aggregator.

    An interruption queued at the pipeline head dies in the user aggregator while the user is muted
    (llm_response_universal.py:1188-1203), so an explicit "interrupt" is broadcast from here.
    """

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

    async def interrupt(self) -> None:
        await self.broadcast_interruption()


class Emitter:
    """Decouples the pipeline from the WebSocket: observers only enqueue."""

    def __init__(self, link: Link) -> None:
        self._link = link
        self._queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=2000)
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._pump())

    def emit(self, message_type: str, data: dict[str, Any] | None = None) -> None:
        try:
            self._queue.put_nowait((message_type, data or {}))
        except asyncio.QueueFull:
            pass

    async def _pump(self) -> None:
        while True:
            message_type, data = await self._queue.get()
            await self._link.send(message_type, data)
            self._queue.task_done()

    async def stop(self, timeout_s: float = 1.0) -> None:
        if self._task is None:
            return
        try:
            await asyncio.wait_for(self._queue.join(), timeout_s)
        except TimeoutError:
            pass
        self._task.cancel()


class BridgeObserver(BaseObserver):
    """Turns pipeline frames into protocol events.

    ``on_push_frame`` fires on every hop and broadcast frames travel both ways, so each event is
    taken from exactly one push: the processor that produces it, downstream.
    """

    def __init__(
        self,
        emit: Callable[[str, dict[str, Any] | None], None],
        *,
        input_processor: FrameProcessor,
        output_processor: FrameProcessor,
        user_aggregator: FrameProcessor,
        llm: FrameProcessor,
        device_name: str = "",
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._emit = emit
        self._input = input_processor
        self._output = output_processor
        self._user_aggregator = user_aggregator
        self._llm = llm
        self._level = LevelMeter()
        self._device = device_name
        self._peak = 0.0
        self._audio_since: float | None = None
        self._silence_reported = False
        self._heard_user = False
        self._reply: list[str] = []

    def take_reply(self) -> str:
        text = "".join(self._reply).strip()
        self._reply = []
        return text

    def _watch_for_silence(self, pcm16: bytes, now: float) -> None:
        """A microphone that delivers zeros is the one failure a user cannot see.

        Opening the wrong input device succeeds and then streams silence, so the session looks
        alive and never answers. Reported once, and only until the user is heard.
        """
        if self._silence_reported or self._heard_user:
            return
        if self._audio_since is None:
            self._audio_since = now
        self._peak = max(self._peak, rms_level(pcm16))
        if now - self._audio_since < SILENT_MIC_SECS:
            return
        self._silence_reported = True
        if self._peak < SILENT_MIC_LEVEL:
            self._emit("warning", {"code": "micSilent", "device": self._device})

    async def on_push_frame(self, data: FramePushed) -> None:
        frame, source = data.frame, data.source
        if isinstance(frame, InputAudioRawFrame):
            if source is self._input:
                now = time.monotonic()
                level = self._level.update(frame.audio, now)
                if level is not None:
                    self._emit("level", {"value": level})
                self._watch_for_silence(frame.audio, now)
            return
        if data.direction != FrameDirection.DOWNSTREAM:
            return
        if source is self._output:
            if isinstance(frame, BotStartedSpeakingFrame):
                self._emit("state", {"event": "bot.started"})
            elif isinstance(frame, BotStoppedSpeakingFrame):
                self._emit("state", {"event": "bot.stopped"})
        elif source is self._user_aggregator:
            if isinstance(frame, UserStartedSpeakingFrame):
                self._heard_user = True
                self._emit("state", {"event": "user.started"})
            elif isinstance(frame, UserStoppedSpeakingFrame):
                self._emit("state", {"event": "user.stopped"})
        elif source is self._llm:
            if isinstance(frame, LLMFullResponseStartFrame):
                self._reply = []
            elif isinstance(frame, LLMTextFrame):
                self._reply.append(frame.text)
                self._emit("assistant.delta", {"text": frame.text})
            elif isinstance(frame, FunctionCallsStartedFrame):
                names = [call.function_name for call in frame.function_calls]
                self._emit("state", {"event": "tools.started", "tools": names})


def _language(code: str | None) -> Language | None:
    if not code:
        return None
    try:
        return Language(code)
    except ValueError:
        logger.warning(f"Unknown STT language {code!r}; using automatic detection")
        return None


def tools_schema(specs: tuple[dict[str, Any], ...] | list[dict[str, Any]]) -> ToolsSchema:
    return ToolsSchema(
        standard_tools=[
            FunctionSchema(
                name=spec["name"],
                description=spec["description"],
                properties=spec["properties"],
                required=spec["required"],
            )
            for spec in specs
        ]
    )


def build_services(cfg: SessionConfig, device: str):
    """Load and warm the models. Blocking (models load in the service constructors)."""
    stt = ThreadedWhisperSTTService(
        device=device,
        compute_type="int8_float16" if device == "cuda" else "int8",
        settings=WhisperSTTService.Settings(
            model=cfg.whisper_model,
            language=_language(cfg.stt_language),
            no_speech_prob=NO_SPEECH_PROB,
            hotwords=cfg.hotwords or None,
        ),
    )
    stt.warm_up()

    extra = (
        {"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}} if cfg.llm_local else {}
    )
    llm = LocalOpenAILLMService(
        # openai 3.x refuses an empty key; llama-server ignores it.
        api_key=cfg.llm_api_key or "sk-local",
        base_url=cfg.llm_base_url,
        function_call_timeout_secs=TOOL_TIMEOUT_SECS,
        settings=OpenAILLMService.Settings(
            model=cfg.llm_model, system_instruction=cfg.system_prompt, extra=extra
        ),
    )

    for path in (cfg.kokoro_model_path, cfg.kokoro_voices_path):
        # pipecat would otherwise download the model into a missing explicit path.
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
    tts = KokoroTTSService(
        model_path=cfg.kokoro_model_path,
        voices_path=cfg.kokoro_voices_path,
        settings=KokoroTTSService.Settings(
            voice=cfg.kokoro_voice,
            language=Language.FR if cfg.kokoro_language.startswith("fr") else Language.EN,
            speed=1.0,
        ),
    )
    # TTSService builds its aggregator internally (tts_service.py:330) with no parameter to replace
    # it: swap it so a long first sentence does not hold back the first audio.
    tts._text_aggregator = FirstClauseTextAggregator(aggregation_type=tts._text_aggregation_mode)
    # Private attribute (kokoro/tts.py:212): a first synthesis loads espeak and the ONNX graph.
    tts._kokoro.create("Bonjour.", voice=cfg.kokoro_voice, lang=cfg.kokoro_language)
    return stt, llm, tts


def composed_system_prompt(cfg: SessionConfig) -> str:
    """The system prompt the LLM service will really send (turn_completion.system_prompt_for)."""
    turn_config = getattr(turn_strategies(cfg), "config", None)
    return system_prompt_for(
        cfg.system_prompt,
        turn_instructions=turn_config.completion_instructions if turn_config else "",
        async_tool_instructions=ASYNC_TOOL_INSTRUCTIONS,
    )


async def warm_llm(cfg: SessionConfig) -> float:
    """Make the model server process the system prompt and the tool schemas once, up front.

    Measured on the first five-turn run: the first request of a session spent 8.8 s before its
    first token, all of it prompt processing. Sending the same prefix during startup moves that
    cost out of the first spoken turn. Returns the seconds it took.
    """
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=cfg.llm_api_key or "sk-local", base_url=cfg.llm_base_url, max_retries=0)
    request: dict[str, Any] = {
        "model": cfg.llm_model,
        "messages": [
            {"role": "system", "content": composed_system_prompt(cfg)},
            {"role": "user", "content": "ping"},
        ],
        "max_completion_tokens": 1,
    }
    if cfg.tools:
        request["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": spec["name"],
                    "description": spec["description"],
                    "parameters": {
                        "type": "object",
                        "properties": spec["properties"],
                        "required": spec["required"],
                    },
                },
            }
            for spec in cfg.tools
        ]
    if cfg.llm_local:
        request["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
    started = time.perf_counter()
    try:
        await client.chat.completions.create(**request)
    except Exception as exc:  # noqa: BLE001 - a cold start is not worth failing the session
        logger.warning(f"LLM warm-up failed: {exc}")
    finally:
        await client.close()
    return time.perf_counter() - started


def turn_strategies(cfg: SessionConfig) -> UserTurnStrategies:
    """When the user's turn ends.

    A short silence asks the model. With ``wait_for_complete_turns`` its verdict decides: ● is
    answered, ◐ (cut off) and ○ (thinking) keep the turn open in silence. Pipecat's own
    instructions are used, and its spoken nudge after 5 s / 10 s is pushed out of reach
    (see turn_completion.py for the measurements behind both).
    """
    start = [VADUserTurnStartStrategy(), TranscriptionUserTurnStartStrategy()]
    # An explicit detector: Pipecat's default loads Smart Turn v3.2 (8/10 on French test clips).
    stop = [SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=TURN_STOP_TIMEOUT_SECS)]
    if not cfg.wait_for_complete_turns:
        return UserTurnStrategies(start=start, stop=stop)
    return FilterIncompleteUserTurnStrategies(
        start=start,
        stop=stop,
        config=UserTurnCompletionConfig(
            incomplete_short_timeout=NEVER_NUDGE_SECS,
            incomplete_long_timeout=NEVER_NUDGE_SECS,
        ),
    )


def resolve_microphone(wanted: str) -> DeviceChoice:
    """Which input device the session will open, decided before the transport exists."""
    import pyaudio

    py_audio = pyaudio.PyAudio()
    try:
        return resolve_input_device(py_audio, wanted)
    finally:
        py_audio.terminate()


def _local_audio_transport(
    input_device_index: int | None = None,
) -> tuple[FrameProcessor, FrameProcessor, Callable[[], None]]:
    transport = LocalAudioTransport(
        LocalAudioTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            input_device_index=input_device_index,
        )
    )
    # pipecat never terminates PyAudio (local/audio.py:218).
    return transport.input(), transport.output(), transport._pyaudio.terminate


class VoiceBot:
    def __init__(
        self,
        cfg: SessionConfig,
        link: Link,
        stt: ThreadedWhisperSTTService,
        llm: OpenAILLMService,
        tts: KokoroTTSService,
        *,
        transport_factory: TransportFactory | None = None,
        ready_data: dict[str, Any] | None = None,
    ) -> None:
        self._link = link
        self._stt = stt
        self._ready_data = ready_data or {}
        self._started = False
        self._emitter = Emitter(link)
        self.tools = ToolBridge(link.send)
        self.mute = SessionMuteStrategy(mute_while_bot_speaks=cfg.barge_in != "interrupt")

        if transport_factory is None:
            self.input_device = resolve_microphone(cfg.input_device)
            logger.info(
                f"Microphone: {self.input_device.name!r} ({self.input_device.status})"
                f" for requested {cfg.input_device!r}"
            )
            transport_factory = partial(_local_audio_transport, self.input_device.index)
        else:
            self.input_device = DeviceChoice(None, "", "harness")
        input_processor, output_processor, self._close_transport = transport_factory()

        llm.register_function(
            None, self._on_tool_call, cancel_on_interruption=False, timeout_secs=TOOL_TIMEOUT_SECS
        )
        context = LLMContext(tools=tools_schema(cfg.tools)) if cfg.tools else LLMContext()
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                vad_analyzer=SileroVADAnalyzer(
                    params=VADParams(stop_secs=0.2, min_volume=cfg.vad_min_volume)
                ),
                user_turn_strategies=turn_strategies(cfg),
                user_mute_strategies=[self.mute, FunctionCallUserMuteStrategy()],
            ),
        )
        self.gate = InterruptGate(name="ow-interrupt-gate")
        pipeline = Pipeline(
            [
                input_processor,
                stt,
                user_aggregator,
                self.gate,
                llm,
                tts,
                output_processor,
                assistant_aggregator,
            ]
        )

        self._observer = BridgeObserver(
            self._emitter.emit,
            input_processor=input_processor,
            output_processor=output_processor,
            user_aggregator=user_aggregator,
            llm=llm,
            device_name=self.input_device.name,
        )
        latency = UserBotLatencyObserver()

        @latency.event_handler("on_latency_breakdown")
        async def _on_latency(_observer, breakdown: LatencyBreakdown):
            self._emitter.emit(
                "latency",
                latency_payload(
                    breakdown.total_secs,
                    [(c.key, c.duration_secs) for c in breakdown.contributions],
                ),
            )

        self.worker = PipelineWorker(
            pipeline,
            params=PipelineParams(
                audio_in_sample_rate=16000, audio_out_sample_rate=24000, enable_metrics=True
            ),
            observers=[self._observer, latency],
            enable_rtvi=False,
            idle_timeout_secs=None,
        )

        @self.worker.event_handler("on_pipeline_started")
        async def _on_started(_worker, _frame):
            self._started = True
            self._emitter.emit(
                "ready",
                {
                    **self._ready_data,
                    "inputDevice": self.input_device.name,
                    "inputDeviceStatus": self.input_device.status,
                },
            )

        @self.worker.event_handler("on_pipeline_error")
        async def _on_error(_worker, frame: ErrorFrame):
            self._emitter.emit("error", {"message": str(frame.error)})

        @user_aggregator.event_handler("on_user_turn_stopped")
        async def _on_user_turn(_aggregator, _strategy, message):
            text = (message.content or "").strip()
            self._emitter.emit(
                "transcript.final",
                {
                    "text": text,
                    "language": self._stt.last_language,
                    "languageProbability": self._stt.last_language_probability,
                },
            )

        @user_aggregator.event_handler("on_user_turn_stop_timeout")
        async def _on_user_turn_timeout(_aggregator):
            self._emitter.emit("state", {"event": "turn.idle"})

        @assistant_aggregator.event_handler("on_assistant_turn_stopped")
        async def _on_assistant_turn(_aggregator, message):
            spoken = (message.content or "").strip()
            text = self._observer.take_reply() or spoken
            # A turn that only called a tool has no text of its own: nothing to show or store.
            if text or spoken:
                self._emitter.emit(
                    "assistant.final",
                    {
                        "text": text,
                        "spokenText": spoken,
                        "interrupted": bool(message.interrupted),
                    },
                )
            self._emitter.emit("state", {"event": "turn.idle"})

    async def _on_tool_call(self, params: FunctionCallParams) -> None:
        name = params.function_name
        confirmable = name in CONFIRMABLE_TOOLS
        if confirmable:
            self._emitter.emit("state", {"event": "confirm.requested", "tool": name})
            phrase = SPOKEN_ACKS.get(name, CONFIRM_PHRASE)
            await params.llm.push_frame(TTSSpeakFrame(phrase, append_to_context=False))
        try:
            outcome = await self.tools.call(name, dict(params.arguments))
        finally:
            if confirmable:
                self._emitter.emit("state", {"event": "confirm.resolved", "tool": name})
        result = {"success": outcome.success, "result": outcome.text}
        if name == "delegate_task" and outcome.success:
            # Already acknowledged aloud; completion is announced by OpenWhispr.
            await params.result_callback(
                result, properties=FunctionCallResultProperties(run_llm=False)
            )
            return
        # A truthy result makes the LLM answer with it (llm_response_universal.py:1922).
        await params.result_callback(result)

    def _handlers(self) -> dict[str, Callable[[dict[str, Any]], Any]]:
        async def say(message):
            text = str(message["data"].get("text") or "").strip()
            if text:
                await self.worker.queue_frame(TTSSpeakFrame(text, append_to_context=False))

        async def interrupt(_message):
            if self._started:
                await self.gate.interrupt()

        def mute(message):
            self.mute.manual_mute = bool(message["data"].get("value"))

        async def update_tools(message):
            from .session_config import tool_specs

            specs = tool_specs(message["data"].get("tools"))
            await self.worker.queue_frame(LLMSetToolsFrame(tools=tools_schema(specs)))

        async def shutdown(_message):
            await self.worker.cancel(reason="shutdown requested by OpenWhispr")

        return {
            "tool.result": lambda message: self.tools.resolve(message.get("id"), message["data"]),
            "say": say,
            "interrupt": interrupt,
            "mute": mute,
            "update_tools": update_tools,
            "shutdown": shutdown,
        }

    async def run(self) -> None:
        self._emitter.start()
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(self.worker)
        run_task = asyncio.create_task(runner.run())
        link_task = asyncio.create_task(self._link.run(self._handlers()))
        try:
            done, _ = await asyncio.wait({run_task, link_task}, return_when=asyncio.FIRST_COMPLETED)
            if run_task not in done:
                logger.info("OpenWhispr closed the conversation link; stopping the pipeline")
                await self.worker.cancel(reason="conversation link closed")
                try:
                    await asyncio.wait_for(run_task, 10)
                except TimeoutError:
                    logger.warning("The pipeline did not stop within 10 s")
        finally:
            self.tools.cancel_all()
            await self._emitter.stop()
            await self._link.send("bye", {})
            await self._link.close()
            link_task.cancel()
            try:
                self._close_transport()
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"Audio transport did not close cleanly: {exc}")
