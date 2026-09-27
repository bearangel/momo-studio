#!/usr/bin/env bash
# scripts/lib/common.sh — 运维脚本公共守卫（source 使用，不直接执行）
#
# Node 20 钉死：本仓库铁律 Node 20 LTS（Node 26 破坏 better-sqlite3 native
# binding；24/22 非验证环境）。旧脚本「nvm use 20 || nvm use 22 + 只挡 <20」
# 会静默放行错误版本——正是 ABI 混乱的源头之一。
# 强制跳过（不推荐）：MOMO_ALLOW_ANY_NODE=1

momo_require_node20() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
    nvm use 20 >/dev/null 2>&1 || true
  fi
  local major
  major=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null) || {
    echo "❌ node 不可用——先安装 Node 20（nvm install 20）"
    exit 1
  }
  if [ "$major" != "20" ] && [ "${MOMO_ALLOW_ANY_NODE:-}" != "1" ]; then
    echo "❌ 本仓库钉死 Node 20 LTS（26 破坏 better-sqlite3；其余版本非验证环境）。当前 $(node -v)"
    echo "   修复: nvm install 20 && nvm use 20"
    echo "   强制跳过: MOMO_ALLOW_ANY_NODE=1 $0"
    exit 1
  fi
}

momo_require_deps() {
  if [ ! -d node_modules ]; then
    echo "❌ node_modules 不存在，请先运行: ./scripts/setup.sh"
    exit 1
  fi
}

# better-sqlite3 在 pnpm 虚拟存储中的包目录（prebuild-install 的工作目录）。
# 注意：仓库根的 `pnpm rebuild better-sqlite3` 可能静默 no-op（AGENTS.md 陷阱），
# 唯一可靠的 Node ABI 切法是在包目录跑 prebuild-install。
momo_sqlite_pkg_dir() {
  ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1
}

# ABI 探测（真实构造触发 dlopen——裸 require 不加载 native，假阴性）：
#   $1=node    → 系统 Node 20（vitest 侧）
#   $1=electron→ dev 依赖的 Electron 二进制（GUI/打包侧）；$2=Electron 可执行文件路径
# 输出 0=匹配，1=不匹配/不可加载
momo_abi_ok() {
  local mode="$1" probe="new (require(process.env.MOMO_SQLITE_PATH))(':memory:').exec('select 1')"
  if [ "$mode" = "node" ]; then
    node -e "$probe" >/dev/null 2>&1
  else
    ELECTRON_RUN_AS_NODE=1 "$2" -e "$probe" >/dev/null 2>&1
  fi
}
