#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}"
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

: "${REMOTE_HOST:?REMOTE_HOST is required in .env}"
: "${REMOTE_USER:?REMOTE_USER is required in .env}"

APP_DIR="${REMOTE_APP_DIR:-/opt/max_bot}"

SSH_ARGS=(-o StrictHostKeyChecking=accept-new)
SCP_ARGS=(-o StrictHostKeyChecking=accept-new)

if [[ -n "${REMOTE_PASSWORD:-}" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "REMOTE_PASSWORD is set, but sshpass is not installed"
    echo "Install sshpass or clear REMOTE_PASSWORD to use ssh key auth"
    exit 1
  fi
  SSH_CMD=(sshpass -p "${REMOTE_PASSWORD}" ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${REMOTE_HOST}")
  SCP_CMD=(sshpass -p "${REMOTE_PASSWORD}" scp "${SCP_ARGS[@]}")
else
  SSH_CMD=(ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${REMOTE_HOST}")
  SCP_CMD=(scp "${SCP_ARGS[@]}")
fi

echo "Preparing ${REMOTE_HOST}:${APP_DIR}"
"${SSH_CMD[@]}" "mkdir -p '${APP_DIR}/src' '${APP_DIR}/scripts'"

echo "Uploading files"
"${SCP_CMD[@]}" "${ROOT_DIR}/package.json" "${REMOTE_USER}@${REMOTE_HOST}:${APP_DIR}/package.json"
"${SCP_CMD[@]}" "${ROOT_DIR}/package-lock.json" "${REMOTE_USER}@${REMOTE_HOST}:${APP_DIR}/package-lock.json"
"${SCP_CMD[@]}" "${ROOT_DIR}/ecosystem.config.js" "${REMOTE_USER}@${REMOTE_HOST}:${APP_DIR}/ecosystem.config.js"
"${SCP_CMD[@]}" "${ROOT_DIR}/src/index.js" "${REMOTE_USER}@${REMOTE_HOST}:${APP_DIR}/src/index.js"
"${SCP_CMD[@]}" "${ROOT_DIR}/.env" "${REMOTE_USER}@${REMOTE_HOST}:${APP_DIR}/.env"

echo "Installing dependencies and restarting service"
"${SSH_CMD[@]}" "cd '${APP_DIR}' && if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi"
"${SSH_CMD[@]}" "npm install -g pm2 >/dev/null 2>&1 || true"
"${SSH_CMD[@]}" "cd '${APP_DIR}' && pm2 startOrRestart ecosystem.config.js --update-env && pm2 save"

echo "Deploy complete. View logs:"
echo "  pm2 logs max-repost-bot --lines 100"
