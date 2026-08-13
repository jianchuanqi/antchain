#!/usr/bin/env bash
set -euo pipefail

suite_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
myfish_version="1.2.1"

(
  cd "$suite_dir/algorithm-registry"
  npx --yes "@antchain/myfish@$myfish_version" compile
)

(
  cd "$suite_dir/eco-label-registry"
  npx --yes "@antchain/myfish@$myfish_version" compile
)

(
  cd "$suite_dir/unified-registry"
  npx --yes "@antchain/myfish@$myfish_version" compile
)

shasum -a 256 \
  "$suite_dir/algorithm-registry/dist/index.wasc" \
  "$suite_dir/algorithm-registry/dist/index.abi" \
  "$suite_dir/eco-label-registry/dist/index.wasc" \
  "$suite_dir/eco-label-registry/dist/index.abi" \
  "$suite_dir/unified-registry/dist/index.wasc" \
  "$suite_dir/unified-registry/dist/index.abi"

if [[ -n "${ECO_LABEL_ARCHIVE_RELEASE:-}" ]]; then
  if [[ ! "$ECO_LABEL_ARCHIVE_RELEASE" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    echo "ECO_LABEL_ARCHIVE_RELEASE is invalid" >&2
    exit 2
  fi
  archive_dir="$suite_dir/releases/$ECO_LABEL_ARCHIVE_RELEASE"
  if [[ -e "$archive_dir" ]]; then
    echo "Refusing to overwrite immutable contract release: $archive_dir" >&2
    exit 3
  fi
  mkdir -p \
    "$archive_dir/algorithm-registry" \
    "$archive_dir/eco-label-registry" \
    "$archive_dir/unified-registry"
  install -m 0444 \
    "$suite_dir/algorithm-registry/assembly/index.ts" \
    "$suite_dir/algorithm-registry/dist/index.wasc" \
    "$suite_dir/algorithm-registry/dist/index.abi" \
    "$archive_dir/algorithm-registry/"
  install -m 0444 \
    "$suite_dir/eco-label-registry/assembly/index.ts" \
    "$suite_dir/eco-label-registry/dist/index.wasc" \
    "$suite_dir/eco-label-registry/dist/index.abi" \
    "$archive_dir/eco-label-registry/"
  install -m 0444 \
    "$suite_dir/unified-registry/assembly/index.ts" \
    "$suite_dir/unified-registry/dist/index.wasc" \
    "$suite_dir/unified-registry/dist/index.abi" \
    "$archive_dir/unified-registry/"
  (
    cd "$archive_dir"
    shasum -a 256 \
      algorithm-registry/index.ts \
      algorithm-registry/index.wasc \
      algorithm-registry/index.abi \
      eco-label-registry/index.ts \
      eco-label-registry/index.wasc \
      eco-label-registry/index.abi \
      unified-registry/index.ts \
      unified-registry/index.wasc \
      unified-registry/index.abi > SHA256SUMS
    chmod 0444 SHA256SUMS
  )
  echo "Archived immutable contract release: $archive_dir"
fi
