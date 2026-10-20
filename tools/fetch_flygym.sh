#!/usr/bin/env bash
# Sparse-checkout flygym's NeuroMechFly assets at the pinned commit into vendor/flygym.
# Note: the v2.1.0 tag (ca65a51) predates this commit; the 7 commits in between
# touch only docs/ and wasm/, so src/ is identical to the PyPI flygym==2.1.0 wheel.
set -euo pipefail

COMMIT=38c8ec61034cd59bc5ba0de20688d4a3c0000d60
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor/flygym"

if [ ! -d "$DEST/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/NeLy-EPFL/flygym.git "$DEST"
fi
git -C "$DEST" sparse-checkout set --no-cone \
  /src/flygym/assets/model/neuromechfly/ \
  /src/flygym/anatomy.py \
  /src/flygym/compose/
git -C "$DEST" -c advice.detachedHead=false checkout -q "$COMMIT"
echo "flygym at $(git -C "$DEST" rev-parse HEAD)"
