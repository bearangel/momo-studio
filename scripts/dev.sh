#!/usr/bin/env bash
set -euo pipefail
if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; nvm use 20 2>/dev/null || nvm use 22 2>/dev/null || true; fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then echo "❌ 需要 Node 20+，当前 $(node -v)"; exit 1; fi
cd "$(dirname "$0")/.."
echo "📦 重建 Electron native binding..."
npx pnpm@9.0.0 --filter ./electron exec -- npx @electron/rebuild -f -w better-sqlite3 -w keytar
echo "🚀 启动开发模式..."
npx pnpm@9.0.0 dev
