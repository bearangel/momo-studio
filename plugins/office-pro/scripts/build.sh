#!/usr/bin/env bash
# office-pro vendor 构建：安装运行库到 vendor/node_modules（联网一次）。
# 内网替代：npm --offline --cache <预置缓存目录>，或 npm config set registry <私服>。
set -euo pipefail
cd "$(dirname "$0")/../vendor"
npm install --omit=dev --no-audit --no-fund
echo "vendor 就绪: $(pwd)/node_modules"
