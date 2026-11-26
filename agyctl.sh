#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/config.env" ]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/config.env"
fi

CURRENT_USER="$(id -un)"
CURRENT_UID="$(id -u)"
WEB_HOST="${AGY_WEB_HOST:-127.0.0.1}"
WEB_PORT="${AGY_WEB_PORT:-13081}"
LS_PORT="${AGY_LS_HTTP_PORT:-13082}"
PROFILE_ROOT="${AGY_PROFILE_ROOT:-${HOME}/.config/agy-headless}"
WORKSPACE_DIR="${AGY_DEFAULT_WORKSPACE:-${HOME}}"
NODE_BIN="${AGY_NODE_BIN:-$(command -v node || echo /usr/bin/node)}"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"

# Target the real user systemd bus (/run/user/<uid>) even when invoked from a nested session
export XDG_RUNTIME_DIR="/run/user/${CURRENT_UID}"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
unset XDG_CONFIG_HOME

ACTION="${1:-status}"

render_unit() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|__PROJECT_ROOT__|${SCRIPT_DIR}|g" \
    -e "s|__WORKSPACE_DIR__|${WORKSPACE_DIR}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    "${src}" > "${dst}"
}

install_units() {
  if [ ! -f "${SCRIPT_DIR}/config.env" ]; then
    echo "[agyctl] Missing ${SCRIPT_DIR}/config.env. Copy config.env.example to config.env and edit it first." >&2
    exit 1
  fi
  chmod +x "${SCRIPT_DIR}/agyctl.sh" "${SCRIPT_DIR}/backend/start_backend.sh"
  mkdir -p "${SYSTEMD_USER_DIR}" "${HOME}/.local/bin" "${PROFILE_ROOT}/antigravity" "${PROFILE_ROOT}/Antigravity/logs"
  render_unit "${SCRIPT_DIR}/systemd/agy-backend.service.template" "${SYSTEMD_USER_DIR}/agy-backend.service"
  render_unit "${SCRIPT_DIR}/systemd/agy-web-gateway.service.template" "${SYSTEMD_USER_DIR}/agy-web-gateway.service"
  ln -sfn "${SCRIPT_DIR}/agyctl.sh" "${HOME}/.local/bin/agyctl"
  systemctl --user daemon-reload
}

wait_for_health() {
  echo "[agyctl] Waiting for gateway on http://${WEB_HOST}:${WEB_PORT}/__agy_gateway_health ..."
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    local out
    out="$(curl -fsS --max-time 2 --noproxy '*' "http://${WEB_HOST}:${WEB_PORT}/__agy_gateway_health" 2>/dev/null || true)"
    if echo "${out}" | grep -q '"servesAppUi": true'; then
      echo "[agyctl] Gateway and backend are healthy!"
      echo "${out}"
      return 0
    fi
    sleep 1
  done
  echo "[agyctl] Gateway responded or is still warming up; current health:"
  curl -s --max-time 3 --noproxy '*' "http://${WEB_HOST}:${WEB_PORT}/__agy_gateway_health" || echo "(unavailable)"
  return 0
}

case "${ACTION}" in
  install)
    install_units
    systemctl --user enable agy-backend.service agy-web-gateway.service
    echo "[agyctl] systemd user units installed and enabled."
    ;;
  start)
    systemctl --user daemon-reload
    systemctl --user start agy-backend.service agy-web-gateway.service
    wait_for_health
    ;;
  stop)
    systemctl --user stop agy-web-gateway.service agy-backend.service
    ;;
  restart)
    systemctl --user daemon-reload
    systemctl --user restart agy-backend.service
    wait_for_health
    ;;
  restart-gateway)
    systemctl --user daemon-reload
    systemctl --user restart agy-web-gateway.service
    wait_for_health
    ;;
  health)
    curl -s --max-time 3 --noproxy '*' "http://${WEB_HOST}:${WEB_PORT}/__agy_gateway_health"
    echo ""
    ;;
  status)
    systemctl --user status --no-pager agy-backend.service agy-web-gateway.service || true
    echo ""
    echo "--- Gateway health (http://${WEB_HOST}:${WEB_PORT}/__agy_gateway_health) ---"
    curl -s --max-time 3 --noproxy '*' "http://${WEB_HOST}:${WEB_PORT}/__agy_gateway_health" \
      || echo "(gateway health endpoint unavailable)"
    echo ""
    echo "--- language_server & gateway listeners owned by ${CURRENT_USER} ---"
    ss -ltnp 2>/dev/null | grep -E ":(${WEB_PORT}|${LS_PORT})\b|language_server" || echo "(none)"
    ;;
  logs)
    journalctl --user -u agy-backend.service -u agy-web-gateway.service -n 80 --no-pager
    ;;
  *)
    echo "Usage: $0 {install|start|stop|restart|restart-gateway|status|health|logs}"
    exit 1
    ;;
esac
