#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${HOME}/.pi/agent/extensions"
AGENTS_DIR="${HOME}/.pi/agent/agents"
ENGTEAM_DIR="${HOME}/.pi/engteam"
DIST_DIR="$(dirname "$0")/../dist"

if [ ! -f "$DIST_DIR/index.js" ]; then
  echo "ERROR: dist/index.js not found. Run 'pnpm build' first." >&2
  exit 1
fi

mkdir -p "$EXTENSION_DIR" "$AGENTS_DIR" "$ENGTEAM_DIR/runs"

cp "$DIST_DIR/index.js" "$EXTENSION_DIR/pi-engteam.js"
echo "Installed extension: $EXTENSION_DIR/pi-engteam.js"

# Install the observability server so /observe can spawn it
cp "$DIST_DIR/server.js" "$ENGTEAM_DIR/server.js"
chmod +x "$ENGTEAM_DIR/server.js"
echo "Installed server:    $ENGTEAM_DIR/server.js"

# Install agent markdown files
for md in "$(dirname "$0")/../agents/"*.md; do
  cp "$md" "$AGENTS_DIR/engteam-$(basename "$md")"
  echo "Installed agent: $AGENTS_DIR/engteam-$(basename "$md")"
done

echo ""
echo "pi-engteam installed. Restart Pi and run /team-start to boot the team."
