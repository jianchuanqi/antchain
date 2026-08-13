#!/usr/bin/env bash
set -euo pipefail

suite_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
myfish_version="1.2.1"
target="${1:-}"

if [[ "${MYFISH_DEBUG:-}" == "1" || "${NODE_ENV:-}" == "development" || "${DEBUG:-}" == *"antchain"* ]]; then
  echo "Disable AntChain/Myfish debug logging; the upstream SDK may print credentials" >&2
  exit 2
fi

export ANTCHAIN_REST_URL="${ANTCHAIN_REST_URL:-${BLOCKCHAIN_REST_URL:-}}"
export ANTCHAIN_BIZ_ID="${ANTCHAIN_BIZ_ID:-${BLOCKCHAIN_BIZ_ID:-}}"
export ANTCHAIN_ACCESS_ID="${ANTCHAIN_ACCESS_ID:-${BLOCKCHAIN_ACCESS_ID:-}}"
export ANTCHAIN_ACCOUNT="${ANTCHAIN_ACCOUNT:-${BLOCKCHAIN_ACCOUNT:-}}"
export ANTCHAIN_TENANT_ID="${ANTCHAIN_TENANT_ID:-${BLOCKCHAIN_TENANT_ID:-}}"
export ANTCHAIN_KMS_ID="${ANTCHAIN_KMS_ID:-${BLOCKCHAIN_KMS_KEY_ID:-}}"

if [[ -n "${ANTCHAIN_ACCESS_SECRET_FILE:-}" ]]; then
  if [[ ! -f "$ANTCHAIN_ACCESS_SECRET_FILE" ]]; then
    echo "ANTCHAIN_ACCESS_SECRET_FILE does not exist" >&2
    exit 2
  fi
  ANTCHAIN_ACCESS_SECRET="$(<"$ANTCHAIN_ACCESS_SECRET_FILE")"
  export ANTCHAIN_ACCESS_SECRET
fi
if [[ -n "${ANTCHAIN_ACCOUNT_PRIVATE_KEY_FILE:-}" ]]; then
  if [[ ! -f "$ANTCHAIN_ACCOUNT_PRIVATE_KEY_FILE" ]]; then
    echo "ANTCHAIN_ACCOUNT_PRIVATE_KEY_FILE does not exist" >&2
    exit 2
  fi
  ANTCHAIN_ACCOUNT_PRIVATE_KEY="$(<"$ANTCHAIN_ACCOUNT_PRIVATE_KEY_FILE")"
  export ANTCHAIN_ACCOUNT_PRIVATE_KEY
fi

required=(
  ANTCHAIN_REST_URL ANTCHAIN_BIZ_ID ANTCHAIN_ACCESS_ID
  ANTCHAIN_ACCESS_SECRET ANTCHAIN_ACCOUNT
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 2
  fi
done

if [[ -n "${ANTCHAIN_KMS_ID:-}" ]]; then
  if [[ -z "${ANTCHAIN_TENANT_ID:-}" ]]; then
    echo "Missing required environment variable for KMS mode: ANTCHAIN_TENANT_ID" >&2
    exit 2
  fi
elif [[ -z "${ANTCHAIN_ACCOUNT_PRIVATE_KEY:-}" ]]; then
  echo "Local-key mode requires ANTCHAIN_ACCOUNT_PRIVATE_KEY or ANTCHAIN_ACCOUNT_PRIVATE_KEY_FILE" >&2
  exit 2
fi

case "$target" in
  unified)
    (
      cd "$suite_dir/unified-registry"
      npx --yes "@antchain/myfish@$myfish_version" compile
      npx --yes "@antchain/myfish@$myfish_version" deploy
    )
    echo "After independent deployment/code verification, initialize the unified registry with initialize()."
    ;;
  algorithm)
    (
      cd "$suite_dir/algorithm-registry"
      npx --yes "@antchain/myfish@$myfish_version" compile
      npx --yes "@antchain/myfish@$myfish_version" deploy
    )
    echo "After final receipt verification, initialize the deployed AlgorithmRegistry with initialize()."
    ;;
  label)
    : "${ECO_ALGORITHM_REGISTRY_ID:?Set the verified 64-hex AlgorithmRegistry contract identity}"
    if [[ ! "$ECO_ALGORITHM_REGISTRY_ID" =~ ^[0-9a-f]{64}$ ]]; then
      echo "ECO_ALGORITHM_REGISTRY_ID must be 64 lowercase hex characters" >&2
      exit 2
    fi
    (
      cd "$suite_dir/eco-label-registry"
      npx --yes "@antchain/myfish@$myfish_version" compile
      npx --yes "@antchain/myfish@$myfish_version" deploy
    )
    echo "After final receipt verification, initialize EcoLabelRegistry with initialize(\"$ECO_ALGORITHM_REGISTRY_ID\")."
    ;;
  *)
    echo "Usage: $0 unified|algorithm|label" >&2
    echo "The unified target is the current release; algorithm/label are retained for historical Compat deployments only." >&2
    exit 2
    ;;
esac
