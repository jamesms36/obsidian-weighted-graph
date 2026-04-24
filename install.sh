#!/bin/bash
set -e

VAULT="${1:-}"
if [ -z "$VAULT" ]; then
  echo "Usage: ./install.sh /path/to/your/obsidian/vault"
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ ! -d "node_modules" ]; then
  echo "Installing build dependencies..."
  npm install
fi

echo "Building..."
npm run build

PLUGIN_DIR="$VAULT/.obsidian/plugins/obsidian-weighted-graph"
mkdir -p "$PLUGIN_DIR"
cp main.js manifest.json styles.css "$PLUGIN_DIR/"

echo ""
echo "Installed to: $PLUGIN_DIR"
echo ""
echo "Next: In Obsidian → Settings → Community Plugins → enable 'Weighted Graph'"
echo "Then click the graph icon in the left ribbon, or run the command 'Open weighted graph'"
