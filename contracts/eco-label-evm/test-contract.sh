#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RPC_PORT="${ECO_LABEL_EVM_TEST_RPC_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
LOG_FILE="$(mktemp -t eco-label-evm-ganache.XXXXXX.log)"

cleanup() {
  if [[ -n "${GANACHE_PID:-}" ]]; then
    kill "${GANACHE_PID}" >/dev/null 2>&1 || true
    wait "${GANACHE_PID}" >/dev/null 2>&1 || true
  fi
  : >"${LOG_FILE}"
}
trap cleanup EXIT INT TERM

cd "${ROOT_DIR}"
npx --yes ganache@7.9.2 \
  --server.host 127.0.0.1 \
  --server.port "${RPC_PORT}" \
  --logging.quiet \
  --wallet.deterministic \
  --chain.hardfork shanghai >"${LOG_FILE}" 2>&1 &
GANACHE_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "http://127.0.0.1:${RPC_PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

ECO_LABEL_EVM_TEST_RPC_URL="http://127.0.0.1:${RPC_PORT}" \
  deno test --no-check \
  --allow-read=contracts/eco-label-evm \
  --allow-net="127.0.0.1:${RPC_PORT}" \
  --allow-env \
  contracts/eco-label-evm/test
