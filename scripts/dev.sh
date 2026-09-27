#!/usr/bin/env bash
# scripts/dev.sh — 开发模式入口（vite HMR + tsc watch + Electron，编排见 electron/scripts/dev.mjs）
#
# v2 精简说明：旧版每次启动前全量 build renderer + build electron + electron-rebuild
# （约 1 分钟）——dev.mjs 用 vite dev server（从不读 renderer/dist）、自带 tsc watch，
# 三步全部冗余。现在只在 native ABI 面孔不对时才重建（探测 ~1s；不兜住的话
# dev 启动必挂 ERR_DLOPEN_FAILED）。
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/common.sh
momo_require_node20
momo_require_deps

SQLITE_DIR=$(momo_sqlite_pkg_dir)
[ -n "$SQLITE_DIR" ] || { echo "❌ 未找到 better-sqlite3 包目录（先跑 ./scripts/setup.sh）"; exit 1; }
EB=$(cd electron && node -p "require('electron')")
export MOMO_SQLITE_PATH="./$SQLITE_DIR"
if momo_abi_ok electron "$EB"; then
  echo "✅ native ABI 已是 Electron——跳过 rebuild"
else
  echo "⚠️ native ABI 不是 Electron（上次跑了 vitest？）——切换中..."
  ./scripts/abi.sh electron
fi

echo "🚀 启动开发模式（vite HMR + tsc watch + Electron）..."
exec npx pnpm@9.0.0 dev
