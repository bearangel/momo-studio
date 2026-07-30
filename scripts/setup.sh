#!/usr/bin/env bash
set -euo pipefail
if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; nvm use 20 2>/dev/null || nvm use 22 2>/dev/null || true; fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then echo "❌ 需要 Node 20+，当前 $(node -v)"; exit 1; fi

cd "$(dirname "$0")/.."

# 1. 安装依赖
if [ ! -d node_modules ]; then
  echo "📦 首次安装依赖..."
  npx pnpm@9.0.0 install
else
  echo "📦 更新依赖..."
  npx pnpm@9.0.0 install --frozen-lockfile
fi

# 2. 重建 Electron native binding
echo "🔧 重建 Electron native binding..."
npx pnpm@9.0.0 --filter ./electron exec -- npx @electron/rebuild -f -w better-sqlite3 -w keytar

# 3. macOS: 编译 Tuwunel（本地开发需要）
BINARY_PATH="resources/conduit/tuwunel-darwin-arm64"
if [ "$(uname)" = "Darwin" ] && [ ! -f "$BINARY_PATH" ]; then
  echo "🦀 编译 Tuwunel for macOS（首次约 10-15 分钟）..."
  if ! command -v cargo &> /dev/null; then
    echo "📦 安装 Rust 工具链..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
  fi
  TMP_DIR=$(mktemp -d)
  git clone --depth 1 https://github.com/matrix-construct/tuwunel.git "$TMP_DIR/tuwunel"
  (cd "$TMP_DIR/tuwunel" && cargo build --release)
  cp "$TMP_DIR/tuwunel/target/release/tuwunel" "$BINARY_PATH"
  chmod +x "$BINARY_PATH"
  rm -rf "$TMP_DIR"
  echo "✅ Tuwunel 编译完成"
elif [ "$(uname)" = "Darwin" ] && [ -f "$BINARY_PATH" ]; then
  echo "✅ Tuwunel 已存在，跳过编译"
fi

echo ""
echo "✅ 环境准备完成！"
echo "   开发: ./scripts/dev.sh"
echo "   测试: ./scripts/test.sh"
echo "   构建: ./scripts/build.sh"
