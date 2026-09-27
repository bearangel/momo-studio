#!/usr/bin/env bash
# scripts/dist.sh — 本地打包安装包（mac / linux；Windows 本地不支持，打包走 CI）
#
# 完整发版闸门（typecheck + test + build）见 docs/dev/release.md；本脚本只做打包。
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/common.sh
momo_require_node20
momo_require_deps

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then echo "用法: ./scripts/dist.sh [mac|linux]"; exit 1; fi
case "$PLATFORM" in
  mac)   FLAG="--mac" ;;
  linux) FLAG="--linux" ;;
  *) echo "不支持: ${PLATFORM}（可选: mac / linux；Windows 本地构建不支持——打包走 CI）"; exit 1 ;;
esac

# 关键防线——显式 electron-rebuild，不能省：
# electron-builder 打包时的自动 rebuild（@electron/rebuild）可能静默 no-op
# （2026-09-25 mac 打包实测：装出 Node ABI 二进制、打包 app 起不来），
# 此处强制重建并用真实构造验证（abi.sh electron 含验证步骤）。
./scripts/abi.sh electron

echo "📝 Typecheck..."
npx pnpm@9.0.0 typecheck
echo "🔨 Build..."
npx pnpm@9.0.0 build
echo "📦 electron-builder $FLAG..."
npx pnpm@9.0.0 --filter ./electron exec electron-builder -- "$FLAG" --publish never
echo "✅ 打包完成:"
ls -lh electron/dist-installers/*.dmg electron/dist-installers/*.AppImage electron/dist-installers/*.deb 2>/dev/null
