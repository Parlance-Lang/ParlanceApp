# Parlance SLM training

> **iPhone now ships Gemma 4 GEC** (`training/models/parlance-gec-es`, `parlance-gec-fr`), staged and
> split by `./training/prepare_ios_coach_model.sh`; see **training/ARCHIVE_SPANISH.md**. The Qwen 0.5B
> tables below describe the Android GGUF models and the earlier iPhone builds.

## Spanish — Qwen 0.5B (Android GGUF; iPhone before 2.4 build 38)

| Item | Status |
|------|--------|
| Merged HF weights | `training/models/parlance-es/model.safetensors` (~942 MB) |
| MLX 4-bit (iOS) | `training/models/parlance-es-mlx/` (~294 MB) — `python3 training/export_parlance_mlx.py --lang es` |
| Smoke test (Python) | `python3 training/smoke_test_slm.py es` |
| App provider | **Parlance Coach** in ⚙ AI (Spanish journal) |
| iOS inference | **MLX Swift** (`mlx-swift-lm`) — bundled at archive |

## French — Qwen 0.5B (Android GGUF; iPhone before 2.4 build 38)

| Item | Status |
|------|--------|
| Merged HF weights | `training/models/parlance-fr/model.safetensors` (~942 MB, Mac training) |
| Adapter (training) | `training/checkpoints/parlance-fr/final_adapter/` |
| MLX 4-bit (iOS) | `training/models/parlance-fr-mlx/` (~294 MB) — `python3 training/export_parlance_mlx.py --lang fr` |
| Smoke test (Python) | `python3 training/smoke_test_slm.py fr` |
| App provider | **Parlance Coach** in ⚙ AI (French journal) |
| Eval (Mac train) | eval_loss ~0.6648 |

See **training/ARCHIVE_SPANISH.md** for Xcode archive steps (Spanish + French).

## Feedback JSON schema (2026-06)

Coach inference returns **`assessed_level`** (`A1`–`C2`) and **`complexity_note`**. Retrain with the level-focused pipeline (see **`training/COACH_QUALITY.md`**):

```bash
cd training && ./run_level_retrain.sh es 2
```

After migrate: `data/spanish/assessed_level_es.jsonl` → `prepare_slm_data.py` → `finetune_slm.py --mac`. Golden checks: `python3 run_coach_regression.py --lang es`.

## Quick commands

```bash
# Verify merged HF (~942 MB each, not ~437 MB broken export)
ls -lh training/models/parlance-es/model.safetensors
ls -lh training/models/parlance-fr/model.safetensors

# Stage both Gemma GEC models + split shared weights for iOS archive
./training/prepare_ios_coach_model.sh

# Legacy Qwen MLX export (one language)
python3 training/export_parlance_mlx.py --lang fr
python3 training/smoke_test_slm.py fr

# Optional dev server (Simulator / Mac testing)
python3 training/parlance_slm_server.py
```

## Timeline

| | |
|--|--|
| Spanish trained (Colab) | 2026-05-21 ~85 min (T4) |
| Spanish re-exported merged | 2026-05-22 (943 MB) |
| French trained (Mac) | 2026-05-22 (eval_loss ~0.6648) |
| MLX export + iOS wiring (es + fr) | 2026-05-22 |
