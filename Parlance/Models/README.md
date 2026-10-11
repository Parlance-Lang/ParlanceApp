# Parlance Coach MLX weights (not in git)

Fine-tuned Spanish and French models for on-device coaching:

| Language | Bundle folder | Training export |
|----------|---------------|-----------------|
| Spanish | `Parlance/Models/parlance-es-mlx/` | `training/models/parlance-gec-es/` |
| French | `Parlance/Models/parlance-fr-mlx/` | `training/models/parlance-gec-fr/` |

Run before archiving (stages both fused Gemma models, then splits out the shared weights):

```bash
./training/prepare_ios_coach_model.sh
```

Spanish and French are fused Gemma 4 GEC models (~2.5 GB each) staged from `training/models/parlance-gec-<lang>`. Two full checkpoints exceed the App Store 4 GB thinned-size limit, so the script then runs `training/split_coach_weights.py`:

| Folder | Contents | Size |
|--------|----------|------|
| `parlance-coach-shared/model-shared.safetensors` | Tensors identical in both languages (embeddings, most layers) | ~2.0 GB |
| `parlance-<lang>-mlx/model-coach.safetensors` | Tensors unique to that language, plus config and tokenizer | ~0.6 GB |

`ParlanceSLMModelLocator` symlinks the shared file next to each language's files under Application Support at runtime, and MLX merges every `*.safetensors` in the directory. If a future retrain touches the embeddings, the shared file shrinks and the per-language files grow; check the total stays under 4 GB.

Xcode **Copy Bundle Resources** includes blue folder references `parlance-coach-shared`, `parlance-es-mlx`, and `parlance-fr-mlx` so weights appear at the app bundle root.
