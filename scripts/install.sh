#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${HOME}/.pi/agent/extensions"
AGENTS_DIR="${HOME}/.pi/agent/agents"
ENGINEERING_DIR="${HOME}/.pi/engineering-team"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/../dist"
NODE_MODULES="$SCRIPT_DIR/../node_modules"

if [ ! -f "$DIST_DIR/index.js" ]; then
  echo "ERROR: dist/index.js not found. Run 'pnpm build' first." >&2
  exit 1
fi

mkdir -p "$EXTENSION_DIR" "$AGENTS_DIR" "$ENGINEERING_DIR/runs"

# Extension bundle (ESM, loaded by Pi directly)
cp "$DIST_DIR/index.js" "$EXTENSION_DIR/pi-engineering.js"
echo "Installed extension: $EXTENSION_DIR/pi-engineering.js"

# Bundled assets (memory scripts etc.) — must sit alongside the bundle so
# spawnFlush.ts can resolve them via import.meta.url at runtime
if [ -d "$DIST_DIR/assets" ]; then
  cp -r "$DIST_DIR/assets" "$EXTENSION_DIR/assets"
  echo "Installed assets:    $EXTENSION_DIR/assets"
fi

# Observability server (CJS, spawned by Node as a child process)
cp "$DIST_DIR/server.cjs" "$ENGINEERING_DIR/server.cjs"
echo "Installed server:    $ENGINEERING_DIR/server.cjs"

# better-sqlite3 is a native addon — copy only the compiled .node binary next to
# server.cjs so the server can load it via the nativeBinding option (no bindings
# package needed, no full node_modules tree required).
SQLITE3_NODE=$(find "$NODE_MODULES/better-sqlite3/build/Release" -name "better_sqlite3.node" 2>/dev/null | head -1)
if [ -n "$SQLITE3_NODE" ]; then
  cp "$SQLITE3_NODE" "$ENGINEERING_DIR/better_sqlite3.node"
  echo "Installed native:    $ENGINEERING_DIR/better_sqlite3.node"
else
  echo "WARNING: better_sqlite3.node not found — run pnpm install first" >&2
fi

# Agent markdown files
for md in "$SCRIPT_DIR/../agents/"*.md; do
  cp "$md" "$AGENTS_DIR/engineering-$(basename "$md")"
  echo "Installed agent: $AGENTS_DIR/engineering-$(basename "$md")"
done

echo ""
echo "pi-engineering installed. Restart Pi and run /team-start to boot the team."
