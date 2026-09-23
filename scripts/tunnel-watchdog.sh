#!/usr/bin/env bash
# Standalone watchdog for OpenAI MCP tunnel services (rig-bridge-tunnel or pi-mcp-bridge-tunnel).
# Restarts the tunnel service when network routing changes (e.g. Wi-Fi <-> hotspot)
# or when long-poll requests stall (>65s) while internet connectivity is available.
set -euo pipefail

SERVICE_NAME="${1:-rig-bridge-tunnel.service}"
if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
  if systemctl --user is-active --quiet "pi-mcp-bridge-tunnel.service"; then
    SERVICE_NAME="pi-mcp-bridge-tunnel.service"
  else
    exit 0
  fi
fi

STATE_FILE="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/tunnel-watchdog-${SERVICE_NAME}.state"
CURRENT_ROUTE=$(ip route show default 2>/dev/null || true)
if [[ -z "$CURRENT_ROUTE" ]]; then
  exit 0
fi

LAST_ROUTE=""
if [[ -f "$STATE_FILE" ]]; then
  LAST_ROUTE=$(cat "$STATE_FILE" 2>/dev/null || true)
fi

if [[ -n "$LAST_ROUTE" && "$CURRENT_ROUTE" != "$LAST_ROUTE" ]]; then
  if curl -sI --max-time 3 https://api.openai.com/v1/models >/dev/null 2>&1; then
    echo "$CURRENT_ROUTE" > "$STATE_FILE"
    echo "[watchdog] Network route changed; restarting $SERVICE_NAME"
    systemctl --user restart "$SERVICE_NAME"
    exit 0
  fi
fi

echo "$CURRENT_ROUTE" > "$STATE_FILE"

HEALTH_PORT="${HEALTH_PORT:-8081}"
METRICS=$(curl -s --max-time 2 "http://127.0.0.1:${HEALTH_PORT}/metrics" 2>/dev/null || true)
if [[ -z "$METRICS" ]]; then
  exit 0
fi

LAST_POLL=$(echo "$METRICS" | grep 'commands_poll_last_successful_timestamp_seconds' | grep -v '#' | awk '{print $2}' || true)
if [[ -n "$LAST_POLL" ]]; then
  LAST_POLL_INT=$(printf "%.0f" "$LAST_POLL" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if [[ $LAST_POLL_INT -gt 0 ]]; then
    AGE=$(( NOW - LAST_POLL_INT ))
    if [[ $AGE -gt 65 ]]; then
      if curl -sI --max-time 3 https://api.openai.com/v1/models >/dev/null 2>&1; then
        echo "[watchdog] Poll stalled (${AGE}s); restarting $SERVICE_NAME"
        systemctl --user restart "$SERVICE_NAME"
      fi
    fi
  fi
fi
