#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}"
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

ROUTING_CONFIG_PATH="${ROUTING_CONFIG_PATH:-config/routes.json}"
ROUTING_ABS_PATH="${ROOT_DIR}/${ROUTING_CONFIG_PATH}"

if [[ -f "${ROUTING_ABS_PATH}" && "${1:-}" != "--force" ]]; then
  echo "Routing config already exists: ${ROUTING_ABS_PATH}"
  echo "Skip generation. Use './bridge.sh --force' to rebuild."
  exit 0
fi

if [[ "${1:-}" == "--force" ]]; then
  node "${ROOT_DIR}/scripts/bridge-init.js" --force
else
  node "${ROOT_DIR}/scripts/bridge-init.js"
fi

echo "Bridge routes ready: ${ROUTING_ABS_PATH}"
