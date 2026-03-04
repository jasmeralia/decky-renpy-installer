#!/bin/bash
set -e

AUDIT_LEVEL="${1:-low}"
DECK="${2:-deck@orion.local}"
PLUGIN="decky-renpy-installer"

VALID_LEVELS="low moderate high critical"

if [ -n "${1}" ]; then
    valid=0
    for level in ${VALID_LEVELS}; do
        if [ "${1}" = "${level}" ]; then
            valid=1
            break
        fi
    done
    if [ "${valid}" -eq 0 ]; then
        echo "❌ Invalid audit level: '${1}'"
        echo "Usage: $0 [low|moderate|high|critical] [user@host]"
        exit 1
    fi
fi

echo "🔍 Running lint check..."
pnpm run lint
echo "✅ Lint passed"

echo "🔍 Running pnpm audit (level: ${AUDIT_LEVEL})..."
pnpm audit --audit-level="${AUDIT_LEVEL}"
echo "✅ No audit vulnerabilities found"

echo "🔨 Building..."
pnpm run build
echo "✅ Build complete"

echo "🚀 Deploying to ${DECK}..."
rsync -av plugin.json main.py "${DECK}:/home/deck/homebrew/plugins/${PLUGIN}/"
rsync -av --delete ./dist/ "${DECK}:/home/deck/homebrew/plugins/${PLUGIN}/dist/"
ssh "${DECK}" "sudo systemctl restart plugin_loader"
echo "✅ Deploy complete"
