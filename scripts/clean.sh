#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "🧹 清理构建产物..."
rm -rf electron/dist renderer/dist electron/dist-installers test-results/ playwright-report/
echo "✅ 清理完成（node_modules 保留）"
