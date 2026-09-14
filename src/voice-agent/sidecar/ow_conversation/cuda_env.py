"""Make the CUDA libraries installed by pip loadable before faster-whisper is imported.

On Windows, ctranslate2 loads cuBLAS and cuDNN with LoadLibrary at the first CUDA inference, so
os.add_dll_directory is not enough: the nvidia wheels' bin folders must be on PATH. Failures only
show at the first transcription, which is why the sidecar warms up before it reports ready.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def nvidia_bin_dirs(prefix: str | os.PathLike[str] | None = None) -> list[str]:
    """Return the bin folders of the nvidia-* wheels installed in this environment."""
    root = Path(prefix or sys.prefix)
    candidates = [root / "Lib" / "site-packages" / "nvidia", root / "lib" / "site-packages" / "nvidia"]
    for base in candidates:
        if base.is_dir():
            return sorted(str(p) for p in base.glob("*/bin") if p.is_dir())
    return []


def prepare_cuda_path(environ: dict[str, str] | None = None, prefix: str | None = None) -> list[str]:
    """Prepend the nvidia bin folders to PATH (idempotent). Returns the folders added."""
    env = os.environ if environ is None else environ
    dirs = nvidia_bin_dirs(prefix)
    current = env.get("PATH", "")
    parts = current.split(os.pathsep) if current else []
    missing = [d for d in dirs if d not in parts]
    if missing:
        env["PATH"] = os.pathsep.join(missing + parts)
    return missing
