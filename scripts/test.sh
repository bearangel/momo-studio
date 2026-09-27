#!/usr/bin/env bash
# scripts/test.sh — 双 workspace 单元测试
#
# ABI 前置：vitest 在系统 Node 下加载 better-sqlite3（Node ABI 面）——
# 上次跑过 dev/打包后二进制是 Electron ABI，直接跑测试必挂 ERR_DLOPEN_FAILED。
# 注意：仓库根 `pnpm rebuild better-sqlite3` 会静默 no-op（AGENTS.md 陷阱），
# 唯一可靠切法是包目录 prebuild-install（由 abi.sh 封装，含真实构造验证）。
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/common.sh
momo_require_node20
momo_require_deps

SQLITE_DIR=$(momo_sqlite_pkg_dir)
[ -n "$SQLITE_DIR" ] || { echo "❌ 未找到 better-sqlite3 包目录（先跑 ./scripts/setup.sh）"; exit 1; }
export MOMO_SQLITE_PATH="./$SQLITE_DIR"
if momo_abi_ok node; then
  echo "✅ native ABI 已是 Node——跳过切换"
else
  echo "⚠️ native ABI 不是 Node（上次 dev/打包过？）——切换中..."
  ./scripts/abi.sh node
fi

echo "🧪 运行测试..."
npx pnpm@9.0.0 test
