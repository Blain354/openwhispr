import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from ow_conversation import preview
from ow_conversation.session_config import parse_session_config, parse_tts_config

KOKORO = {"provider": "kokoro", "modelPath": "C:/k/kokoro-v1.0.onnx", "voicesPath": "C:/k/voices-v1.0.bin"}
LOCAL_LLM = {"baseURL": "http://127.0.0.1:8222/v1", "local": True}
OPENAI = {
    "provider": "openai",
    "baseURL": "https://api.openai.com/v1/",
    "voice": "coral",
    "model": "gpt-4o-mini-tts",
    "instructions": "  Accent québécois. ",
}


def test_kokoro_is_the_default_voice_and_its_values_are_bounded():
    tts = parse_tts_config({**KOKORO, "voice": "af_heart", "speed": 9, "language": "de"})
    assert (tts.provider, tts.voice, tts.speed, tts.language) == ("kokoro", "af_heart", 2.0, "fr-fr")
    assert parse_tts_config(KOKORO).voice == "ff_siwis"
    assert parse_tts_config({**KOKORO, "language": "en-us"}).language == "en-us"
    with pytest.raises(ValueError):
        parse_tts_config({**KOKORO, "voice": "../../etc"})
    with pytest.raises(ValueError):
        parse_tts_config({"provider": "kokoro"})
    with pytest.raises(ValueError):
        parse_tts_config({**KOKORO, "provider": "elevenlabs"})


def test_an_older_app_that_sends_kokoro_still_gets_its_voice():
    cfg = parse_session_config(
        {"llm": LOCAL_LLM, "kokoro": {"modelPath": "m", "voicesPath": "v", "voice": "ff_siwis"}}
    )
    assert cfg.tts.provider == "kokoro" and cfg.tts.model_path == "m" and cfg.tts.voice == "ff_siwis"


def test_an_online_voice_needs_https_a_known_voice_and_its_key_which_is_never_printed():
    tts = parse_tts_config({**OPENAI, "instructions": OPENAI["instructions"] + "x" * 600}, api_key="sk-secret-value")
    assert tts.base_url == "https://api.openai.com/v1" and tts.voice == "coral"
    assert tts.instructions.startswith("Accent québécois.") and len(tts.instructions) == 500
    assert "sk-secret-value" not in repr(tts)
    with pytest.raises(ValueError):
        parse_tts_config(OPENAI)
    with pytest.raises(ValueError):
        parse_tts_config({**OPENAI, "voice": "ff_siwis"}, api_key="k")
    with pytest.raises(ValueError):
        parse_tts_config({**OPENAI, "baseURL": "http://203.0.113.10/v1"}, api_key="k")
    cfg = parse_session_config({"llm": LOCAL_LLM, "tts": OPENAI}, tts_api_key="k")
    assert cfg.tts.api_key == "k" and cfg.tts.instructions == "Accent québécois."


def test_a_preview_is_a_mono_16_bit_wav_in_the_reading_language():
    data = preview.wav_bytes(b"\x01\x00" * 2400, 24000)
    with wave.open(io.BytesIO(data)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) == (1, 2, 24000, 2400)
    assert preview.preview_text("en-us") == preview.PREVIEW_TEXT["en"]
    assert preview.preview_text("fr-fr") == preview.PREVIEW_TEXT["fr"]


def test_a_kokoro_preview_reads_the_chosen_voice_speed_and_language():
    calls = []

    class FakeKokoro:
        def __init__(self, model_path, voices_path):
            calls.append((model_path, voices_path))

        def create(self, text, *, voice, speed, lang):
            calls.append((text, voice, speed, lang))
            return [0.0, 0.5, -2.0], 24000

    tts = parse_tts_config({**KOKORO, "voice": "af_heart", "speed": 1.2, "language": "en-us"})
    pcm, rate = preview.kokoro_pcm(tts, "Hello", kokoro_factory=FakeKokoro)
    assert rate == 24000
    assert pcm == b"".join(value.to_bytes(2, "little", signed=True) for value in (0, 16383, -32767))
    assert calls == [(KOKORO["modelPath"], KOKORO["voicesPath"]), ("Hello", "af_heart", 1.2, "en-us")]


def test_an_openai_preview_sends_the_sessions_request_with_the_key_to_that_endpoint_only():
    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            seen["path"] = self.path
            seen["auth"] = self.headers.get("Authorization")
            seen["body"] = json.loads(self.rfile.read(length))
            body = b"\x00\x01" * 1200
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        tts = parse_tts_config(
            {**OPENAI, "baseURL": f"http://127.0.0.1:{server.server_port}/v1", "voice": "marin"},
            api_key="k-test",
        )
        pcm, rate = preview.openai_pcm(tts, "Bonjour")
    finally:
        server.shutdown()
    assert rate == 24000 and len(pcm) == 2400
    assert seen["path"] == "/v1/audio/speech"
    assert seen["auth"] == "Bearer k-test"
    assert seen["body"] == {
        "model": "gpt-4o-mini-tts",
        "voice": "marin",
        "input": "Bonjour",
        "response_format": "pcm",
        "instructions": "Accent québécois.",
    }


def test_a_failed_preview_reports_a_status_never_the_providers_message():
    class Refused(Exception):
        status_code = 401

    assert preview.describe_error(Refused("Incorrect API key provided: sk-or-v1****fc9a")) == "HTTP 401"
    assert preview.describe_error(FileNotFoundError("C:/k/voices.bin")) == "FileNotFoundError: C:/k/voices.bin"


def test_an_online_voice_is_pipecats_openai_speech_service_with_the_first_clause_aggregator():
    from ow_conversation import bot
    from ow_conversation.text_aggregator import FirstClauseTextAggregator

    tts = bot.build_tts(parse_tts_config(OPENAI, api_key="k"))
    assert type(tts).__name__ == "OpenAITTSService"
    assert tts._settings.voice == "coral" and tts._settings.model == "gpt-4o-mini-tts"
    assert tts._settings.instructions == "Accent québécois."
    assert isinstance(tts._text_aggregator, FirstClauseTextAggregator)
