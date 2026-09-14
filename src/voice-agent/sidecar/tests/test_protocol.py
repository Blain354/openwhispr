import json
import os

import pytest

from ow_conversation import cuda_env
from ow_conversation.protocol import MAX_MESSAGE_BYTES, ProtocolError, decode, encode


def test_encode_produces_a_versioned_envelope():
    message = json.loads(encode("transcript.final", {"text": "Bonjour é"}, turn=2))
    assert message["v"] == 1
    assert message["type"] == "transcript.final"
    assert message["turn"] == 2
    assert message["data"] == {"text": "Bonjour é"}


def test_the_sidecar_cannot_send_app_commands():
    with pytest.raises(ProtocolError):
        encode("shutdown")


@pytest.mark.parametrize(
    "raw, error",
    [
        ('{"v":1,"type":"tool.call","data":{}}', "type"),
        ('{"v":2,"type":"say","data":{}}', "version"),
        ("not json", "invalid-json"),
        ("[1]", "not-object"),
        ('{"v":1,"type":"say","data":[1]}', "data"),
        ('{"v":1,"type":"say","id":3,"data":{}}', "id"),
    ],
)
def test_decode_rejects_malformed_or_foreign_messages(raw, error):
    with pytest.raises(ProtocolError, match=error):
        decode(raw)


def test_decode_rejects_oversized_and_binary_frames():
    with pytest.raises(ProtocolError, match="too-large"):
        decode("x" * (MAX_MESSAGE_BYTES + 1))
    with pytest.raises(ProtocolError):
        decode(b"{}")


def test_decode_accepts_app_commands():
    message = decode('{"v":1,"type":"say","id":"a1","data":{"text":"Salut"}}')
    assert message["data"]["text"] == "Salut"
    assert message["id"] == "a1"


def test_prepare_cuda_path_prepends_nvidia_bins_once(tmp_path):
    for name in ("cublas", "cudnn"):
        (tmp_path / "Lib" / "site-packages" / "nvidia" / name / "bin").mkdir(parents=True)
    env = {"PATH": "C:\\Windows"}
    added = cuda_env.prepare_cuda_path(env, prefix=str(tmp_path))
    assert len(added) == 2
    assert env["PATH"].split(os.pathsep)[-1] == "C:\\Windows"
    assert cuda_env.prepare_cuda_path(env, prefix=str(tmp_path)) == []
