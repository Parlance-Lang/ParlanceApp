# Archive checklist — Parlance Coach on-device (Spanish + French)

## What ships

- **Parlance Coach** in `Parlance/web/journal.js` (Spanish, French, and English journals)
- On-device inference: `ParlanceSLMEngine.swift` + `ParlanceSLMAnalyzer.swift` (MLX Swift)
- iPhone weights: fused **Gemma 4 GEC** models, 4-bit MLX (`training/models/parlance-gec-es`, `training/models/parlance-gec-fr`)
- Android weights: Qwen 0.5B GGUF exports in the `parlance_models` Play asset pack (unchanged by this checklist)
- Weights are **not** in git — copied into the app at build time

## Before you archive (on your Mac)

1. **Fused Gemma models** (~2.5 GB each)

   ```bash
   ls -lh training/models/parlance-gec-es/model.safetensors
   ls -lh training/models/parlance-gec-fr/model.safetensors
   ```

2. **Stage + split for the app**

   ```bash
   ./training/prepare_ios_coach_model.sh
   ```

   Stages both models into `Parlance/Models/parlance-<lang>-mlx/`, then runs
   `split_coach_weights.py --verify`. Two full checkpoints are ~5 GB, over the App Store
   4 GB thinned-size limit (error 90558), so tensors identical in both languages move to
   `Parlance/Models/parlance-coach-shared/model-shared.safetensors` (~2 GB) and each language
   keeps only `model-coach.safetensors` (~0.6 GB).

3. **Xcode**

   - If build fails with *missing Metal Toolchain*: `xcodebuild -downloadComponent MetalToolchain`
   - Open `Parlance.xcodeproj`
   - Wait for Swift packages to resolve (`mlx-swift-lm`, `swift-transformers-mlx`)
   - Product → **Archive** → Distribute (TestFlight), or `fastlane ios`
   - Check the `.app` in the archive is under 4 GB (~3.1 GB as of 2.4 build 39)

4. **Test on device**

   - Journal language → **Spanish** or **French**
   - Write a sentence → first run loads the model (1–2 min); later runs faster
   - No Mac server required

## Build details

| Piece | Spanish | French |
|-------|---------|--------|
| Fused Gemma (training) | `training/models/parlance-gec-es/` | `training/models/parlance-gec-fr/` |
| Staged in app | `parlance-es-mlx/` (config, tokenizer, `model-coach.safetensors`) | `parlance-fr-mlx/` (same) |
| Shared by both | `parlance-coach-shared/model-shared.safetensors` | ← |

At runtime `ParlanceSLMModelLocator` symlinks the language folder and the shared file into
`Application Support/Parlance/linked/<folder>/`; MLX loads every `*.safetensors` there.

If a retrain changes the embeddings, less is shared and the per-language files grow. Re-check
the archive size before uploading.

## Optional: dev Mac server

```bash
python3 training/parlance_slm_server.py
```

Enable dev routing in the app (UserDefaults key `parlance_slm_dev_server` = true) — not enabled by default in release.

## Optional: back up weights outside git

```bash
zip -r ~/Desktop/parlance-gec-es.zip training/models/parlance-gec-es/
zip -r ~/Desktop/parlance-gec-fr.zip training/models/parlance-gec-fr/
```

## Re-stage after retraining one language

Both languages must be staged together, because the shared file depends on both:

```bash
./training/prepare_ios_coach_model.sh
```
