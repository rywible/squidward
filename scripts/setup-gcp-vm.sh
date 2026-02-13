#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${INSTANCE:-squidward}"
ZONE="${ZONE:-us-central1-c}"
REGION="${REGION:-us-central1}"
STATIC_IP_NAME="${STATIC_IP_NAME:-squidward-ip}"
APP_PORT="${APP_PORT:-3000}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
SQUIDWARD_DIR="${SQUIDWARD_DIR:-\$HOME/projects/squidward}"
DOMAIN="${DOMAIN:-}"

if [[ -z "${PROJECT}" ]]; then
  echo "[setup-gcp-vm] PROJECT is not set and gcloud has no default project."
  echo "Set PROJECT=... and retry."
  exit 1
fi

echo "[setup-gcp-vm] project=${PROJECT} instance=${INSTANCE} zone=${ZONE} region=${REGION}"

echo "[setup-gcp-vm] checking gcloud auth..."
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  echo "[setup-gcp-vm] gcloud auth is not valid. Run: gcloud auth login"
  exit 1
fi

echo "[setup-gcp-vm] ensuring static IP ${STATIC_IP_NAME} exists..."
if ! gcloud compute addresses describe "${STATIC_IP_NAME}" \
  --project "${PROJECT}" \
  --region "${REGION}" >/dev/null 2>&1; then
  gcloud compute addresses create "${STATIC_IP_NAME}" \
    --project "${PROJECT}" \
    --region "${REGION}"
fi

STATIC_IP="$(gcloud compute addresses describe "${STATIC_IP_NAME}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --format='get(address)')"

if [[ -z "${STATIC_IP}" ]]; then
  echo "[setup-gcp-vm] failed to resolve static IP."
  exit 1
fi

echo "[setup-gcp-vm] attaching static IP ${STATIC_IP} to instance..."
gcloud compute instances delete-access-config "${INSTANCE}" \
  --project "${PROJECT}" \
  --zone "${ZONE}" \
  --access-config-name "External NAT" >/dev/null 2>&1 || true

gcloud compute instances add-access-config "${INSTANCE}" \
  --project "${PROJECT}" \
  --zone "${ZONE}" \
  --access-config-name "External NAT" \
  --address "${STATIC_IP}" >/dev/null

echo "[setup-gcp-vm] ensuring firewall tags for HTTP/HTTPS..."
gcloud compute instances add-tags "${INSTANCE}" \
  --project "${PROJECT}" \
  --zone "${ZONE}" \
  --tags http-server,https-server >/dev/null

if [[ -z "${DOMAIN}" ]]; then
  DOMAIN="${STATIC_IP}.sslip.io"
fi

echo "[setup-gcp-vm] using domain: ${DOMAIN}"
echo "[setup-gcp-vm] NOTE: ensure DNS A record points ${DOMAIN} -> ${STATIC_IP} (sslip.io works automatically)."

REMOTE_SCRIPT="$(cat <<'EOF'
set -euo pipefail

APP_PORT="{{APP_PORT}}"
DOMAIN="{{DOMAIN}}"
SQUIDWARD_DIR="{{SQUIDWARD_DIR}}"
USER_HOME="$HOME"

if [[ "${SQUIDWARD_DIR}" == "\$HOME/"* ]]; then
  SQUIDWARD_DIR="${USER_HOME}/${SQUIDWARD_DIR#\$HOME/}"
elif [[ "${SQUIDWARD_DIR}" == "\$HOME" ]]; then
  SQUIDWARD_DIR="${USER_HOME}"
fi

echo "[remote] squidward_dir=${SQUIDWARD_DIR}"
if [[ ! -d "${SQUIDWARD_DIR}" ]]; then
  echo "[remote] missing directory: ${SQUIDWARD_DIR}"
  exit 1
fi

sudo apt-get update -y
sudo apt-get install -y curl gnupg2 ca-certificates lsb-release debian-keyring debian-archive-keyring apt-transport-https

if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi

if [[ ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
fi

sudo apt-get update -y
sudo apt-get install -y caddy

cd "${SQUIDWARD_DIR}"

if [[ -x "${HOME}/.bun/bin/bun" ]]; then
  BUN_BIN="${HOME}/.bun/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
else
  echo "[remote] bun not found. Install bun first."
  exit 1
fi

if [[ ! -f ".env" ]]; then
  cp .env.example .env
fi

set_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

set_env "API_HOST" "127.0.0.1"
set_env "API_PORT" "${APP_PORT}"
set_env "AGENT_DB_PATH" "${SQUIDWARD_DIR}/.data/agent.db"
set_env "PRIMARY_REPO_PATH" "${HOME}/projects/wrela"

"${BUN_BIN}" install
"${BUN_BIN}" run --filter dashboard build

sudo tee /etc/systemd/system/squidward-api.service >/dev/null <<UNIT
[Unit]
Description=Squidward API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${SQUIDWARD_DIR}
Environment=PATH=${HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${BUN_BIN} --env-file=.env run --filter @squidward/api start
Restart=always
RestartSec=3
User=${USER}

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/squidward-worker.service >/dev/null <<UNIT
[Unit]
Description=Squidward Worker
After=network-online.target squidward-api.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${SQUIDWARD_DIR}
Environment=PATH=${HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${BUN_BIN} --env-file=.env run --filter @squidward/worker start
Restart=always
RestartSec=3
User=${USER}

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${DOMAIN} {
  reverse_proxy 127.0.0.1:${APP_PORT}
}
CADDY

sudo systemctl daemon-reload
sudo systemctl enable squidward-api squidward-worker caddy
sudo systemctl restart squidward-api squidward-worker caddy

echo "[remote] services:"
sudo systemctl --no-pager --full status squidward-api squidward-worker caddy | sed -n '1,80p'
EOF
)"

REMOTE_SCRIPT="${REMOTE_SCRIPT//\{\{APP_PORT\}\}/${APP_PORT}}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//\{\{DOMAIN\}\}/${DOMAIN}}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//\{\{SQUIDWARD_DIR\}\}/${SQUIDWARD_DIR}}"
REMOTE_SCRIPT_B64="$(printf '%s' "${REMOTE_SCRIPT}" | base64 | tr -d '\n')"

echo "[setup-gcp-vm] provisioning remote VM..."
gcloud compute ssh "${INSTANCE}" \
  --project "${PROJECT}" \
  --zone "${ZONE}" \
  --command "bash -lc 'echo ${REMOTE_SCRIPT_B64} | base64 -d > /tmp/squidward-bootstrap.sh && bash /tmp/squidward-bootstrap.sh'"

echo
echo "[setup-gcp-vm] done."
echo "[setup-gcp-vm] static_ip: ${STATIC_IP}"
echo "[setup-gcp-vm] url: https://${DOMAIN}"
