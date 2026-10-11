#!/usr/bin/env bash
# Prepare Spanish + French Gemma 4 GEC for iOS archive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

prepare_gec() {
  local lang="$1"
  local fused="training/models/parlance-gec-${lang}"
  local bundle_dir="Parlance/Models/parlance-${lang}-mlx"

  echo ""
  echo "==> [${lang}] Stage fused Gemma 4 GEC into the iOS folder name"
  if [[ ! -f "${fused}/config.json" ]]; then
    echo "Missing ${fused}. Fuse adapters/parlance-gec-${lang} first." >&2
    exit 1
  fi
  python3 training/export_gec.py --lang "${lang}"
  du -sh "${bundle_dir}"
}

prepare_gec es
prepare_gec fr

echo ""
echo "==> Split shared tensors out (two full checkpoints exceed the App Store 4 GB limit)"
python3 training/split_coach_weights.py --verify
du -sh Parlance/Models/parlance-coach-shared Parlance/Models/parlance-es-mlx Parlance/Models/parlance-fr-mlx

echo ""
echo "OK. Xcode Copy Bundle Resources bundles:"
echo "  Parlance/Models/parlance-coach-shared/"
echo "  Parlance/Models/parlance-es-mlx/"
echo "  Parlance/Models/parlance-fr-mlx/"
echo "Archive: open Parlance.xcodeproj → Product → Archive (device build)."
