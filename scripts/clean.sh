#!/usr/bin/env bash
# 清理：删除 dist/、dist-installers/、测试临时文件
# 保留 node_modules（重装很慢）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "🧹 清理构建产物..."
rm -rf electron/dist renderer/dist electron/dist-installers test-results/ playwright-report/
rm -rf /tmp/ap-* /tmp/e2e-* /tmp/tw-* /tmp/momo-*

echo "✅ 清理完成（node_modules 保留）"
