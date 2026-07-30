#!/usr/bin/env bash
# 构建：typecheck + build 两个 workspace
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20

cd "$(dirname "$0")/.."

echo "📝 Typecheck..."
npx pnpm@9.0.0 typecheck

echo "🔨 Build..."
npx pnpm@9.0.0 build

echo "✅ Build 完成"
