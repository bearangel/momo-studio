#!/usr/bin/env bash
set -euo pipefail
if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; nvm use 20 2>/dev/null || nvm use 22 2>/dev/null || true; fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then echo "❌ 需要 Node 20+，当前 $(node -v)"; exit 1; fi

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then echo "用法: ./scripts/dist.sh [mac|linux|win]"; exit 1; fi
case "$PLATFORM" in
  mac)   FLAG="--mac" ;;
  linux) FLAG="--linux" ;;
  win)   FLAG="--win" ;;
  *) echo "不支持: $PLATFORM（可选: mac / linux / win）"; exit 1 ;;
esac

cd "$(dirname "$0")/.."
echo "📦 重建 Electron native binding..."
npx pnpm@9.0.0 --filter ./electron exec -- npx @electron/rebuild -f -w better-sqlite3 -w keytar
echo "📝 Typecheck..."
npx pnpm@9.0.0 typecheck
echo "🔨 Build..."
npx pnpm@9.0.0 build
echo "📦 electron-builder $FLAG..."
npx pnpm@9.0.0 --filter ./electron exec electron-builder -- "$FLAG" --publish never
echo "✅ 打包完成:"
ls -lh electron/dist-installers/*.dmg electron/dist-installers/*.AppImage electron/dist-installers/*.deb electron/dist-installers/*.exe 2>/dev/null
