#!/bin/bash
set -e

DECK="${1:-deck@orion.local}"
PLUGIN="decky-renpy-installer"

echo "🔍 Running lint check..."
pnpm run lint
echo "✅ Lint passed"

echo "🔨 Building..."
pnpm run build
echo "✅ Build complete"

echo "🚀 Deploying to ${DECK}..."
rsync -av plugin.json main.py "${DECK}:/home/deck/homebrew/plugins/${PLUGIN}/"
rsync -av --delete ./dist/ "${DECK}:/home/deck/homebrew/plugins/${PLUGIN}/dist/"
ssh "${DECK}" "sudo systemctl restart plugin_loader"
echo "✅ Deploy complete"
