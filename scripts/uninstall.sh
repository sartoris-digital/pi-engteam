#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${HOME}/.pi/agent/extensions"
AGENTS_DIR="${HOME}/.pi/agent/agents"
ENGINEERING_DIR="${HOME}/.pi/engineering-team"

rm -f "$EXTENSION_DIR/pi-engineering.js"
echo "Removed $EXTENSION_DIR/pi-engineering.js"

rm -f "$ENGINEERING_DIR/server.cjs"
echo "Removed $ENGINEERING_DIR/server.cjs"

# Also clean up leftovers from older installs
rm -f "$ENGINEERING_DIR/server.js" "$ENGINEERING_DIR/package.json"

rm -f "$ENGINEERING_DIR/better_sqlite3.node"
echo "Removed $ENGINEERING_DIR/better_sqlite3.node"

# Clean up node_modules copied by older installs
rm -rf "$ENGINEERING_DIR/node_modules"

for f in "$AGENTS_DIR/engineering-"*.md; do
  [ -f "$f" ] && rm "$f" && echo "Removed $f"
done

echo "pi-engineering uninstalled."
