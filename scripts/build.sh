#!/usr/bin/env bash
# scripts/build.sh — 双 workspace typecheck + build
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/common.sh
momo_require_node20
momo_require_deps

echo "📝 Typecheck..."
npx pnpm@9.0.0 typecheck
echo "🔨 Build..."
npx pnpm@9.0.0 build
echo "✅ Build 完成"
