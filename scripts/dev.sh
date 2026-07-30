#!/usr/bin/env bash
# 开发模式：重建 Electron native binding + 启动应用
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20

cd "$(dirname "$0")/.."

echo "📦 重建 Electron native binding..."
npx pnpm@9.0.0 --filter ./electron exec -- npx @electron/rebuild -f -w better-sqlite3 -w keytar

echo "🚀 启动开发模式..."
npx pnpm@9.0.0 dev
