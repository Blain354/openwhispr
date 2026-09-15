import pytest

from ow_conversation.session_config import (
    DEFAULT_VAD_MIN_VOLUME,
    HOTWORDS_MAX_CHARS,
    MAX_TOOLS,
    parse_session_config,
    stt_language_code,
    tool_specs,
    vad_min_volume,
)

KOKORO = {"modelPath": "C:/k/kokoro-v1.0.onnx", "voicesPath": "C:/k/voices-v1.0.bin"}


def test_a_local_session_config_is_parsed_with_safe_defaults():
    cfg = parse_session_config(
        {
            "llm": {"baseURL": "http://127.0.0.1:8222/v1/", "model": "qwen3.5-4b-q4_k_m", "local": True},
            "systemPrompt": "Réponds brièvement.",
            "sttLanguage": "auto",
            "kokoro": KOKORO,
        }
    )
    assert cfg.llm_base_url == "http://127.0.0.1:8222/v1"
    assert cfg.llm_local is True and cfg.llm_api_key == ""
    assert cfg.stt_language is None
    assert cfg.barge_in == "mute"
    assert cfg.kokoro_voice == "ff_siwis" and cfg.kokoro_language == "fr-fr"
    assert cfg.tools == ()
    assert cfg.hotwords == ""


def test_endpoints_must_be_loopback_for_local_models_and_https_for_remote_ones():
    with pytest.raises(ValueError):
        parse_session_config({"llm": {"baseURL": "http://192.168.0.2:8080/v1", "local": True}, "kokoro": KOKORO})
    with pytest.raises(ValueError):
        parse_session_config({"llm": {"baseURL": "http://api.example.com/v1"}, "kokoro": KOKORO})
    remote = parse_session_config(
        {"llm": {"baseURL": "https://api.example.com/v1", "model": "m"}, "kokoro": KOKORO},
        api_key="k",
    )
    assert remote.llm_local is False and remote.llm_api_key == "k"
    with pytest.raises(ValueError):
        parse_session_config({"llm": {"baseURL": "http://127.0.0.1:1/v1", "local": True}})


def test_language_codes():
    assert stt_language_code(None) is None
    assert stt_language_code("AUTO") is None
    assert stt_language_code("fr-CA") == "fr"
    assert stt_language_code("en") == "en"


def test_tool_specs_keep_valid_unique_tools_up_to_the_cap():
    tools = [
        {"name": "open_app", "description": "Open", "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name", 3]}},
        {"name": "open_app", "description": "duplicate"},
        {"name": "bad name!", "description": "invalid"},
        "not a tool",
    ] + [{"name": f"tool_{i}"} for i in range(20)]
    specs = tool_specs(tools)
    assert len(specs) == MAX_TOOLS
    assert specs[0] == {
        "name": "open_app",
        "description": "Open",
        "properties": {"name": {"type": "string"}},
        "required": ["name"],
    }
    assert specs[1] == {"name": "tool_0", "description": "", "properties": {}, "required": []}


def test_hotwords_are_kept_bounded():
    cfg = parse_session_config(
        {
            "llm": {"baseURL": "http://127.0.0.1:8222/v1", "local": True},
            "hotwords": "OpenWhispr, blain-infra, " + "x" * 2000,
            "kokoro": KOKORO,
        }
    )
    assert cfg.hotwords.startswith("OpenWhispr, blain-infra")
    assert len(cfg.hotwords) == HOTWORDS_MAX_CHARS


def test_the_speech_loudness_floor_defaults_below_pipecats_and_stays_in_band():
    # Pipecat's own 0.6 (about -50 LUFS) is never reached by a quiet headset.
    assert DEFAULT_VAD_MIN_VOLUME < 0.6
    assert vad_min_volume(None) == DEFAULT_VAD_MIN_VOLUME
    assert vad_min_volume("loud") == DEFAULT_VAD_MIN_VOLUME
    assert vad_min_volume(float("nan")) == DEFAULT_VAD_MIN_VOLUME
    assert vad_min_volume(0.3) == 0.3
    assert vad_min_volume(0.0) == 0.1
    assert vad_min_volume(5) == 0.9


def test_an_older_app_that_sends_no_floor_still_gets_the_lower_default():
    cfg = parse_session_config({"llm": {"baseURL": "http://127.0.0.1:8222/v1", "local": True}, "kokoro": KOKORO})
    assert cfg.vad_min_volume == DEFAULT_VAD_MIN_VOLUME
    tuned = parse_session_config(
        {"llm": {"baseURL": "http://127.0.0.1:8222/v1", "local": True}, "kokoro": KOKORO, "vadMinVolume": 0.25}
    )
    assert tuned.vad_min_volume == 0.25
    assert tuned.input_device == ""
