#!/usr/bin/env bash
# 打包：重建 Electron binding + typecheck + test + electron-builder
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20

cd "$(dirname "$0")/.."

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then
  echo "用法: ./scripts/dist.sh [mac|linux|win]"
  echo "  mac   → --mac"
  echo "  linux → --linux"
  echo "  win   → --win"
  exit 1
fi

case "$PLATFORM" in
  mac)   BUILDER_FLAG="--mac" ;;
  linux) BUILDER_FLAG="--linux" ;;
  win)   BUILDER_FLAG="--win" ;;
  *) echo "不支持的平台: $PLATFORM（可选: mac / linux / win）"; exit 1 ;;
esac

echo "📦 重建 Electron native binding..."
npx pnpm@9.0.0 --filter ./electron exec -- npx @electron/rebuild -f -w better-sqlite3 -w keytar

echo "📝 Typecheck..."
npx pnpm@9.0.0 typecheck

echo "🔨 Build renderer + electron..."
npx pnpm@9.0.0 build

echo "📦 electron-builder $BUILDER_FLAG..."
npx pnpm@9.0.0 --filter ./electron exec electron-builder -- "$BUILDER_FLAG" --publish never

echo "✅ 打包完成: electron/dist-installers/"
ls -lh electron/dist-installers/*.dmg electron/dist-installers/*.AppImage electron/dist-installers/*.deb electron/dist-installers/*.exe 2>/dev/null
