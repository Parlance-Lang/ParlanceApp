#!/usr/bin/env python3
"""Split staged Gemma Coach weights into one shared file plus small per-language files.

The Spanish and French Gemma 4 GEC models share every embedding and most layer
tensors byte-for-byte. Shipping both full checkpoints puts the iOS app over the
App Store 4 GB thinned-size limit, so this writes:

  Parlance/Models/parlance-coach-shared/model-shared.safetensors  (tensors identical in every language)
  Parlance/Models/parlance-<lang>-mlx/model-coach.safetensors     (tensors unique to that language)

Both names match the `model*.safetensors` glob that Python mlx_lm uses, so the
linked folder also loads in training/smoke tests.

ParlanceSLMModelLocator links the shared file next to each language folder at
runtime; MLX loads every *.safetensors in a model directory and merges them.

Run after training/export_gec.py has staged each language (see
training/prepare_ios_coach_model.sh). Safe to re-run: languages that are already
split are skipped unless a full model.safetensors is staged again.

  python3 training/split_coach_weights.py
  python3 training/split_coach_weights.py --langs es fr --verify
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "Parlance" / "Models"
SHARED_DIR = MODELS / "parlance-coach-shared"
SHARED_FILE = "model-shared.safetensors"
LANG_FILE = "model-coach.safetensors"
FULL_FILE = "model.safetensors"
CHUNK = 64 * 1024 * 1024


def read_header(path: Path) -> tuple[int, dict]:
    with path.open("rb") as f:
        (size,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(size))
    return 8 + size, header


def tensor_bytes(path: Path, data_start: int, entry: dict) -> bytes:
    start, end = entry["data_offsets"]
    with path.open("rb") as f:
        f.seek(data_start + start)
        return f.read(end - start)


def write_safetensors(out: Path, sources: list[tuple[str, Path, int, dict]], metadata: dict | None) -> None:
    """sources: (key, file, data_start, entry). Copies raw tensor bytes; no re-quantization."""
    header: dict = {}
    if metadata:
        header["__metadata__"] = metadata
    offset = 0
    for key, _, _, entry in sources:
        start, end = entry["data_offsets"]
        header[key] = {"dtype": entry["dtype"], "shape": entry["shape"], "data_offsets": [offset, offset + end - start]}
        offset += end - start
    raw = json.dumps(header, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 8)
    tmp = out.with_suffix(".tmp")
    with tmp.open("wb") as w:
        w.write(struct.pack("<Q", len(raw)))
        w.write(raw)
        handles: dict[Path, object] = {}
        try:
            for _, src, data_start, entry in sources:
                f = handles.setdefault(src, src.open("rb"))
                start, end = entry["data_offsets"]
                f.seek(data_start + start)
                left = end - start
                while left:
                    buf = f.read(min(CHUNK, left))
                    w.write(buf)
                    left -= len(buf)
        finally:
            for f in handles.values():
                f.close()
    tmp.replace(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--langs", nargs="+", default=["es", "fr"])
    ap.add_argument("--verify", action="store_true", help="re-read outputs and compare against the full checkpoints before deleting them")
    args = ap.parse_args()

    dirs = {lang: MODELS / f"parlance-{lang}-mlx" for lang in args.langs}
    staged = {lang: d / FULL_FILE for lang, d in dirs.items() if (d / FULL_FILE).is_file()}
    if not staged:
        if all((d / LANG_FILE).is_file() for d in dirs.values()) and (SHARED_DIR / SHARED_FILE).is_file():
            print("Already split; nothing to do.")
            return 0
        print("No staged model.safetensors found. Run training/export_gec.py first.", file=sys.stderr)
        return 1
    if len(staged) != len(dirs):
        missing = sorted(set(dirs) - set(staged))
        print(f"Stage every language before splitting (missing full weights: {', '.join(missing)}).", file=sys.stderr)
        return 1

    headers = {lang: read_header(path) for lang, path in staged.items()}
    first = args.langs[0]
    _, first_header = headers[first]
    metadata = first_header.get("__metadata__")

    shared_keys: list[str] = []
    for key, entry in first_header.items():
        if key == "__metadata__":
            continue
        ref = None
        same = True
        for lang in args.langs:
            data_start, header = headers[lang]
            other = header.get(key)
            if not other or other["shape"] != entry["shape"] or other["dtype"] != entry["dtype"]:
                same = False
                break
            blob = tensor_bytes(staged[lang], data_start, other)
            if ref is None:
                ref = blob
            elif blob != ref:
                same = False
                break
        if same:
            shared_keys.append(key)
    shared_set = set(shared_keys)

    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    data_start, header = headers[first]
    write_safetensors(
        SHARED_DIR / SHARED_FILE,
        [(k, staged[first], data_start, header[k]) for k in shared_keys],
        metadata,
    )
    print(f"shared: {len(shared_keys)} tensors -> {(SHARED_DIR / SHARED_FILE).stat().st_size / 1e9:.2f} GB")

    for lang in args.langs:
        data_start, header = headers[lang]
        own = [k for k in header if k != "__metadata__" and k not in shared_set]
        out = dirs[lang] / LANG_FILE
        write_safetensors(out, [(k, staged[lang], data_start, header[k]) for k in own], header.get("__metadata__"))
        print(f"{lang}: {len(own)} tensors -> {out.stat().st_size / 1e9:.2f} GB")

    if args.verify:
        s_start, s_header = read_header(SHARED_DIR / SHARED_FILE)
        for lang in args.langs:
            data_start, header = headers[lang]
            l_start, l_header = read_header(dirs[lang] / LANG_FILE)
            for key, entry in header.items():
                if key == "__metadata__":
                    continue
                if key in s_header:
                    got = tensor_bytes(SHARED_DIR / SHARED_FILE, s_start, s_header[key])
                else:
                    got = tensor_bytes(dirs[lang] / LANG_FILE, l_start, l_header[key])
                if got != tensor_bytes(staged[lang], data_start, entry):
                    print(f"VERIFY FAILED: {lang} {key}", file=sys.stderr)
                    return 1
        print("verify: every tensor matches the original checkpoints")

    for lang, path in staged.items():
        path.unlink()
        (dirs[lang] / "model.safetensors.index.json").unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
