#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ -f "${PROJECT_ROOT}/config.env" ]; then
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/config.env"
fi

ALLOWED_HOST="${AGY_ALLOWED_HOST:-}"
CURRENT_HOST="$(hostname -s)"
if [ -n "$ALLOWED_HOST" ] && [ "$CURRENT_HOST" != "$ALLOWED_HOST" ]; then
  echo "[agy-backend] refusing to start on ${CURRENT_HOST}; this backend is scoped to ${ALLOWED_HOST}" >&2
  exit 78
fi

PROFILE_ROOT="${AGY_PROFILE_ROOT:-${HOME}/.config/agy-headless}"
APP_ROOT="${AGY_APP_ROOT:-${HOME}/.local/opt/antigravity-app/Antigravity-x64}"
ELECTRON_BIN="${AGY_ELECTRON_BIN:-${APP_ROOT}/antigravity}"
LS_BIN="${AGY_LS_BIN:-${APP_ROOT}/resources/bin/language_server}"
NODE_BIN="${AGY_NODE_BIN:-$(command -v node || true)}"
BACKEND_MODE="${AGY_BACKEND_MODE:-standalone}"
LS_HTTP_PORT="${AGY_LS_HTTP_PORT:-13082}"
LS_LOG_PATH="${AGY_LS_LOG_PATH:-${PROFILE_ROOT}/Antigravity/logs/language_server.log}"
IDE_VERSION="${AGY_IDE_VERSION:-2.28.1}"

export XDG_CONFIG_HOME="${PROFILE_ROOT}"
unset DISPLAY XAUTHORITY WAYLAND_DISPLAY

# Outbound proxy configuration (never proxy localhost/127.0.0.1)
if [ -n "${AGY_PROXY_URL:-}" ]; then
  export HTTP_PROXY="${AGY_PROXY_URL}"
  export HTTPS_PROXY="${AGY_PROXY_URL}"
  export http_proxy="${AGY_PROXY_URL}"
  export https_proxy="${AGY_PROXY_URL}"
  export NO_PROXY="localhost,127.0.0.1,::1"
  export no_proxy="localhost,127.0.0.1,::1"

  # Brief wait for loopback proxy readiness (avoids boot race with a local proxy service)
  if [[ "${AGY_PROXY_URL}" =~ ^https?://(127\.0\.0\.1|localhost):([0-9]+) ]]; then
    PROXY_PORT="${BASH_REMATCH[2]}"
    for _ in 1 2 3 4 5; do
      if (echo >/dev/tcp/127.0.0.1/"${PROXY_PORT}") >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
  fi
else
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
fi

# Prepare isolated headless profile directories
mkdir -p "${PROFILE_ROOT}/Antigravity/bin" \
         "${PROFILE_ROOT}/Antigravity/logs" \
         "${PROFILE_ROOT}/antigravity"
chmod 700 "${PROFILE_ROOT}" "${PROFILE_ROOT}/Antigravity" "${PROFILE_ROOT}/antigravity" 2>/dev/null || true

# Create agy-node wrapper for Antigravity UI sidecars (e.g. agy-telemetry-monitor)
AGY_NODE_WRAPPER="${PROFILE_ROOT}/Antigravity/bin/agy-node"
if [ -x "${ELECTRON_BIN}" ]; then
  cat > "${AGY_NODE_WRAPPER}" <<EOF
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "${ELECTRON_BIN}" "\$@"
EOF
elif [ -n "${NODE_BIN}" ] && [ -x "${NODE_BIN}" ]; then
  cat > "${AGY_NODE_WRAPPER}" <<EOF
#!/bin/sh
exec "${NODE_BIN}" "\$@"
EOF
fi
chmod 755 "${AGY_NODE_WRAPPER}" 2>/dev/null || true

# Build clean user-space PATH (zero references to any other user)
NODE_DIR=""
if [ -n "${NODE_BIN}" ]; then
  NODE_DIR="$(dirname "${NODE_BIN}"):"
fi
export PATH="${PROFILE_ROOT}/Antigravity/bin:${NODE_DIR}${HOME}/.local/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin"

# Expose unpacked chrome-devtools-mcp entry point if installed
MCP_JS="${APP_ROOT}/resources/app.asar.unpacked/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
if [ -f "${MCP_JS}" ]; then
  export CHROME_DEVTOOLS_MCP_JS="${MCP_JS}"
fi

if [ "${BACKEND_MODE}" = "electron" ]; then
  if [ ! -x "${ELECTRON_BIN}" ]; then
    echo "[agy-backend] Electron binary not found: ${ELECTRON_BIN}" >&2
    exit 1
  fi

  # Safe SingletonLock handling: only remove if stale (dead PID on this host)
  LOCK_FILE="${PROFILE_ROOT}/Antigravity/SingletonLock"
  if [ -L "${LOCK_FILE}" ]; then
    LOCK_TARGET="$(readlink "${LOCK_FILE}" || true)"
    LOCK_HOST="${LOCK_TARGET%-*}"
    LOCK_PID="${LOCK_TARGET##*-}"
    if [ "${LOCK_HOST}" = "${CURRENT_HOST}" ] && [[ "${LOCK_PID}" =~ ^[0-9]+$ ]]; then
      if kill -0 "${LOCK_PID}" 2>/dev/null; then
        echo "[agy-backend] Another live Antigravity instance (PID ${LOCK_PID}) already holds ${LOCK_FILE}; aborting." >&2
        exit 1
      fi
      rm -f "${LOCK_FILE}" "${PROFILE_ROOT}/Antigravity/SingletonCookie" "${PROFILE_ROOT}/Antigravity/SingletonSocket"
    fi
  fi

  export ELECTRON_OZONE_PLATFORM_HINT="headless"
  EXTRA_PROXY_ARGS=()
  if [ -n "${AGY_PROXY_URL:-}" ]; then
    EXTRA_PROXY_ARGS+=(--proxy-server="${AGY_PROXY_URL}" '--proxy-bypass-list=localhost;127.0.0.1')
  fi

  exec "${ELECTRON_BIN}" \
    --ozone-platform=headless \
    --headless \
    --disable-gpu \
    --no-sandbox \
    "${EXTRA_PROXY_ARGS[@]}"
fi

# Default mode: direct standalone language_server (no Chromium, no VNC, no SingletonLock, no stdin auth deadlock)
if [ ! -x "${LS_BIN}" ]; then
  echo "[agy-backend] language_server binary not found: ${LS_BIN}" >&2
  exit 1
fi

if [ -r /proc/sys/kernel/random/uuid ]; then
  CSRF_TOKEN="$(cat /proc/sys/kernel/random/uuid)"
else
  CSRF_TOKEN="$(python3 -c 'import uuid; print(uuid.uuid4())')"
fi

echo "[agy-backend] Starting standalone language_server on ${CURRENT_HOST} (user=$(id -un), http_port=${LS_HTTP_PORT}, profile=${PROFILE_ROOT})"

# Keep language_server as the exec'd PID so SIGTERM triggers graceful SQLite flush,
# while mirroring logs to both systemd journal and language_server.log.
: > "${LS_LOG_PATH}"
exec > >(tee -a "${LS_LOG_PATH}") 2>&1

exec "${LS_BIN}" \
  --standalone \
  --override_ide_name antigravity \
  --subclient_type hub \
  --override_ide_version "${IDE_VERSION}" \
  --override_user_agent_name antigravity \
  --http_server_port "${LS_HTTP_PORT}" \
  --https_server_port 0 \
  --csrf_token "${CSRF_TOKEN}" \
  --app_data_dir antigravity \
  --api_server_url https://generativelanguage.googleapis.com \
  --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com \
  --enable_sidecars \
  </dev/null
