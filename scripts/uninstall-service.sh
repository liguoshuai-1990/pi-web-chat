#!/usr/bin/env bash
# Remove the pi-web-chat user systemd service.
# Does NOT delete the project directory or sessions.

set -euo pipefail

UNIT_NAME="pi-web-chat.service"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/$UNIT_NAME"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERR: 'systemctl' not on PATH" >&2; exit 1
fi

if systemctl --user list-unit-files "$UNIT_NAME" 2>/dev/null | grep -q "$UNIT_NAME"; then
  systemctl --user disable --now "$UNIT_NAME" || true
  echo "✔ disabled $UNIT_NAME"
fi

if [[ -f "$DEST" ]]; then
  rm "$DEST"
  systemctl --user daemon-reload
  echo "✔ removed $DEST"
else
  echo "no unit file at $DEST"
fi
