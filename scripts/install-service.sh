#!/usr/bin/env bash
# Install pi-web-chat as a user-level systemd service.
#
# Why user-level? pi reads/writes ~/.pi and cwd files under $HOME, and it
# launches `pi` from ~/.npm-global/bin (or wherever $PI_BIN points). Running
# as a system unit would either need root or your home dir in a bind mount;
# user-level systemd (systemd --user) is the obvious fit and needs no sudo.
#
# Usage:
#   ./scripts/install-service.sh [PORT] [--restart]
#
# After install:
#   journalctl --user -u pi-web-chat -f
#   systemctl --user status pi-web-chat
#   systemctl --user restart pi-web-chat

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$HERE/pi-web-chat.service"
DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DEST="$DEST_DIR/pi-web-chat.service"

PORT="${1:-3000}"
RESTART_NOW="no"
for arg in "$@"; do
  case "$arg" in
    --restart|--now) RESTART_NOW="yes" ;;
  esac
done

# Sanity checks.
if [[ ! -f "$SRC" ]]; then
  echo "ERR: unit file not found at $SRC" >&2; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERR: 'node' not on PATH" >&2; exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERR: 'systemctl' not on PATH — this installer only supports systemd" >&2; exit 1
fi
# User systemd needs linger for services to outlive the login session.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  echo "⚠ Linger is not enabled for $USER — service will stop at logout."
  echo "  To keep it running after logout, run (one-off, requires sudo):"
  echo "    sudo loginctl enable-linger $USER"
fi

mkdir -p "$DEST_DIR/user"

# Concrete paths. The shipped unit uses %h for portability, but %h is only
# resolved when the user systemd instance starts — and we want a file that
# 'systemctl --user status' shows an exact path on, so substitute now.
USER_HOME="$HOME"
PROJECT_DIR="$ROOT"
NODE_BIN="$(command -v node)"

# Read the template and substitute.
sed \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|" \
  -e "s|^ExecStart=.*|ExecStart=$NODE_BIN server.js|" \
  -e "s|^Environment=PORT=.*|Environment=PORT=$PORT|" \
  -e "s|ReadWritePaths=%h/.pi|ReadWritePaths=$USER_HOME/.pi|" \
  -e "s|ReadWritePaths=%h/.npm-global|ReadWritePaths=$USER_HOME/.npm-global|" \
  "$SRC" > "$DEST"

echo "✔ wrote $DEST"

# Reload + (re)enable + start.
systemctl --user daemon-reload
systemctl --user enable pi-web-chat.service
if [[ "$RESTART_NOW" == "yes" ]] || systemctl --user is-active --quiet pi-web-chat.service; then
  systemctl --user restart pi-web-chat.service
else
  systemctl --user start pi-web-chat.service || true
fi

echo
echo "Status:"
systemctl --user --no-pager status pi-web-chat.service || true
echo
echo "Logs:"
echo "  journalctl --user -u pi-web-chat -f"
