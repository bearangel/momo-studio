#!/usr/bin/env bash
# scripts/setup.sh — 首次环境准备（依赖安装 + Electron native binding）
#
# v2.0.0 起 Matrix/Tuwunel 已整体拆除（P1 传输层内迁）——旧版此处的
# Tuwunel 编译段（clone + cargo build 10-15 分钟）已删除：产物目录
# resources/conduit/ 不复存在，且无任何代码消费该二进制。
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/common.sh
momo_require_node20

# 1. 安装依赖
if [ ! -d node_modules ]; then
  echo "📦 首次安装依赖..."
  npx pnpm@9.0.0 install
else
  echo "📦 更新依赖..."
  npx pnpm@9.0.0 install --frozen-lockfile
fi

# 2. 重建 Electron native binding（dev GUI / 打包用 Node ABI 面孔）
echo "🔧 重建 Electron native binding..."
npx pnpm@9.0.0 --filter ./electron exec -- npx @electron/rebuild -f -w better-sqlite3 -w keytar

echo ""
echo "✅ 环境准备完成！"
echo "   开发:     ./scripts/dev.sh"
echo "   测试:     ./scripts/test.sh"
echo "   构建:     ./scripts/build.sh"
echo "   ABI 切换: ./scripts/abi.sh <node|electron>（vitest ↔ dev/打包）"
