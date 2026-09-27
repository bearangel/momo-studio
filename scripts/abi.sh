#!/usr/bin/env bash
# scripts/abi.sh — better-sqlite3 双面 ABI 切换（node ↔ electron）
#
# 本仓库 native 模块的两副面孔：
#   node     → vitest / 纯 Node 脚本用（Node ABI 115）；跑完打包/dev 后跑测试前切换
#   electron → dev GUI / electron-builder 打包用（Electron ABI）；跑完测试后要启动 GUI 前切换
#
# 为什么需要显式切换：
#   - `pnpm rebuild better-sqlite3`（仓库根）会静默 no-op——exit 0 但二进制未换（AGENTS.md 陷阱）
#   - Node ABI 侧唯一可靠切法：包目录 `npx prebuild-install`
#   - Electron ABI 侧：`electron-rebuild -f -w better-sqlite3,keytar`
#   - electron-builder 打包时的自动 rebuild 也可能静默 no-op（2026-09-25 mac 打包实测），
#     打包前务必先跑 `./scripts/abi.sh electron`
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/common.sh
momo_require_node20
momo_require_deps

MODE="${1:?用法: ./scripts/abi.sh <node|electron>}"
SQLITE_DIR=$(momo_sqlite_pkg_dir)
[ -n "$SQLITE_DIR" ] || { echo "❌ 未找到 better-sqlite3 包目录（依赖未安装？）"; exit 1; }
export MOMO_SQLITE_PATH="./$SQLITE_DIR"

case "$MODE" in
  node)
    echo "📦 切换 better-sqlite3 → Node ABI（prebuild-install，包目录直装）..."
    # macOS 主机实测（2026-09-25）：下载产物偶发被 Gatekeeper 判脏 → 加载即 SIGKILL；
    # 且 set -e 下首杀会直接打死脚本（重试分支到不了）——首装失败不致命，交给下方
    # 验证-重试闭环。Linux 无 xattr 命令时跳过。
    (cd "$SQLITE_DIR" && npx prebuild-install) || echo "⚠️ 首次 prebuild 失败（验证阶段将重下）"
    if command -v xattr >/dev/null 2>&1; then
      xattr -c "$SQLITE_DIR/build/Release/better_sqlite3.node" 2>/dev/null || true
    fi
    if momo_abi_ok node; then
      echo "✅ Node ABI 验证通过（真实构造 :memory: 数据库）——可以跑 vitest"
    else
      echo "❌ 切换后仍无法在 Node 下加载——删除产物重下一次"
      rm -f "$SQLITE_DIR/build/Release/better_sqlite3.node"
      (cd "$SQLITE_DIR" && npx prebuild-install) || true
      if command -v xattr >/dev/null 2>&1; then
        xattr -c "$SQLITE_DIR/build/Release/better_sqlite3.node" 2>/dev/null || true
      fi
      if momo_abi_ok node; then
        echo "✅ Node ABI 验证通过（重下后）——可以跑 vitest"
      else
        echo "❌ 二次重下仍失败——检查网络/代理或手动 cd $SQLITE_DIR && npx prebuild-install"
        exit 1
      fi
    fi
    ;;
  electron)
    echo "📦 切换 better-sqlite3 + keytar → Electron ABI（electron-rebuild -f）..."
    (cd electron && npx electron-rebuild -f -w better-sqlite3,keytar)
    EB=$(cd electron && node -p "require('electron')")
    if momo_abi_ok electron "$EB"; then
      echo "✅ Electron ABI 验证通过（dev 依赖的 Electron 二进制真实构造）——可以 dev / 打包"
    else
      echo "❌ 切换后仍无法在 Electron 下加载——检查上方 electron-rebuild 输出"
      exit 1
    fi
    ;;
  *)
    echo "不支持: ${MODE}（可选: node / electron）"
    exit 1
    ;;
esac
