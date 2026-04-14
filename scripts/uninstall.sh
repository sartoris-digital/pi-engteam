#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${HOME}/.pi/agent/extensions"
AGENTS_DIR="${HOME}/.pi/agent/agents"

rm -f "$EXTENSION_DIR/pi-engteam.js"
echo "Removed $EXTENSION_DIR/pi-engteam.js"

for f in "$AGENTS_DIR/engteam-"*.md; do
  [ -f "$f" ] && rm "$f" && echo "Removed $f"
done

echo "pi-engteam uninstalled."
