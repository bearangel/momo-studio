#!/usr/bin/env bash
# 测试模式：重建 Node.js native binding + 跑全部测试
# 注意：vitest 运行在 Node.js 上，需要 Node 版 native binding（不是 Electron 版）
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20

cd "$(dirname "$0")/.."

echo "📦 重建 Node.js native binding（vitest 用）..."
npx pnpm@9.0.0 rebuild better-sqlite3

echo "🧪 运行测试..."
npx pnpm@9.0.0 test
