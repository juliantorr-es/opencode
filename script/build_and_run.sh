#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/packages/desktop"
APP_NAME="OpenCode"
LOG_DIR="${TMPDIR:-/tmp}/opencode-desktop-run"
RUN_LOG="$LOG_DIR/build_and_run.log"

mkdir -p "$LOG_DIR"

kill_existing() {
  pkill -x "$APP_NAME" >/dev/null 2>&1 || true
}

launch_dev_background() {
  cd "$DESKTOP_DIR"
  nohup bun run dev >"$RUN_LOG" 2>&1 &
}

wait_for_app() {
  local attempts=120
  while [ "$attempts" -gt 0 ]; do
    if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  return 1
}

case "$MODE" in
  run)
    kill_existing
    cd "$DESKTOP_DIR"
    exec bun run dev
    ;;
  --debug|debug)
    kill_existing
    cd "$DESKTOP_DIR"
    exec lldb -- bun run dev
    ;;
  --logs|logs)
    kill_existing
    launch_dev_background
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    kill_existing
    launch_dev_background
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"ai.opencode.desktop\""
    ;;
  --verify|verify)
    kill_existing
    launch_dev_background

    if wait_for_app; then
      printf 'OpenCode launched successfully from the repo build.\n'
      exit 0
    fi

    printf 'OpenCode did not appear to launch from the repo build.\n' >&2
    if [ -f "$RUN_LOG" ]; then
      tail -n 120 "$RUN_LOG" >&2 || true
    fi
    exit 1
    ;;
  *)
    printf 'usage: %s [run|--debug|--logs|--telemetry|--verify]\n' "$0" >&2
    exit 2
    ;;
esac
