#!/usr/bin/env bash
set -euo pipefail
if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; nvm use 20 2>/dev/null || nvm use 22 2>/dev/null || true; fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then echo "❌ 需要 Node 20+，当前 $(node -v)"; exit 1; fi

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "📦 首次安装依赖..."
  npx pnpm@9.0.0 install
else
  echo "📦 更新依赖..."
  npx pnpm@9.0.0 install --frozen-lockfile
fi

echo "🔧 重建 Electron native binding..."
npx pnpm@9.0.0 --filter ./electron exec -- npx @electron/rebuild -f -w better-sqlite3 -w keytar

echo "✅ 环境准备完成！"
echo "   开发: ./scripts/dev.sh"
echo "   测试: ./scripts/test.sh"
echo "   构建: ./scripts/build.sh"
