#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${HOME}/.pi/agent/extensions"
AGENTS_DIR="${HOME}/.pi/agent/agents"
ENGTEAM_DIR="${HOME}/.pi/engteam"

rm -f "$EXTENSION_DIR/pi-engteam.js"
echo "Removed $EXTENSION_DIR/pi-engteam.js"

rm -f "$ENGTEAM_DIR/server.cjs"
echo "Removed $ENGTEAM_DIR/server.cjs"

# Also clean up leftovers from older installs
rm -f "$ENGTEAM_DIR/server.js" "$ENGTEAM_DIR/package.json"

rm -f "$ENGTEAM_DIR/better_sqlite3.node"
echo "Removed $ENGTEAM_DIR/better_sqlite3.node"

# Clean up node_modules copied by older installs
rm -rf "$ENGTEAM_DIR/node_modules"

for f in "$AGENTS_DIR/engteam-"*.md; do
  [ -f "$f" ] && rm "$f" && echo "Removed $f"
done

echo "pi-engteam uninstalled."
