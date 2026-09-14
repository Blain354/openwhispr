"""Download the models used by the Conversation mode sidecar. Run once, online.

    uv run --project src/voice-agent/sidecar python src/voice-agent/sidecar/scripts/fetch_models.py

At runtime the sidecar is started with HF_HUB_OFFLINE=1 and never downloads anything.
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

from huggingface_hub import snapshot_download

CONVERSATION_CACHE = Path.home() / ".cache" / "openwhispr" / "conversation"
KOKORO_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
# Hashes of the files the sidecar was measured with.
KOKORO_FILES = {
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}
WHISPER_REPO = "deepdml/faster-whisper-large-v3-turbo-ct2"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_kokoro() -> None:
    target_dir = CONVERSATION_CACHE / "kokoro"
    target_dir.mkdir(parents=True, exist_ok=True)
    for name, expected in KOKORO_FILES.items():
        target = target_dir / name
        if target.is_file() and sha256(target) == expected:
            print(f"ok       {target}")
            continue
        partial = target.with_suffix(target.suffix + ".part")
        print(f"download {KOKORO_RELEASE}/{name}")
        urllib.request.urlretrieve(f"{KOKORO_RELEASE}/{name}", partial)
        actual = sha256(partial)
        if actual != expected:
            partial.unlink()
            raise SystemExit(f"{name}: sha256 {actual} does not match {expected}")
        partial.replace(target)
        print(f"ok       {target}")


def fetch_whisper() -> None:
    path = snapshot_download(WHISPER_REPO)
    print(f"ok       {path}")


def main() -> int:
    fetch_kokoro()
    fetch_whisper()
    return 0


if __name__ == "__main__":
    sys.exit(main())
