#!/usr/bin/env bash
# scripts/fetch-codegraph-engine.sh
#
# 引擎整合 T7（spec §4.1 dev 形态）：从 GitHub Releases 拉取 codegraph 引擎
# bundle（自带 Node 24 运行时 + 完整应用）解压到 plugins/codegraph/engine/。
# bundle 布局 bin/ + lib/ ——与 manifest vendor.probe（engine/bin/codegraph）一致。
#
# 用法:
#   ./scripts/fetch-codegraph-engine.sh                # 按本机平台自动选 target
#   ./scripts/fetch-codegraph-engine.sh darwin-arm64   # 显式指定 target
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) TARGET="darwin-arm64" ;;
    Darwin/x86_64) TARGET="darwin-x64" ;;
    Linux/aarch64) TARGET="linux-arm64" ;;
    Linux/x86_64) TARGET="linux-x64" ;;
    *) echo "无法识别本机平台，请显式传 target（如 darwin-arm64）" >&2; exit 1 ;;
  esac
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DIR="$ROOT/plugins/codegraph/engine"
MANIFEST="$ROOT/plugins/codegraph/momo-plugin.json"
VERSION="$(python3 -c "import json;print(json.load(open('$MANIFEST'))['codegraph']['engineVersion'])")"
BASE="https://github.com/colbymchenry/codegraph/releases/download"
TARBALL="codegraph-$TARGET.tar.gz"
URL="$BASE/v$VERSION/$TARBALL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ 拉取 codegraph v$VERSION [$TARGET]"
echo "  $URL"
curl -fL --retry 2 -o "$TMP/$TARBALL" "$URL"

# SHA256SUMS 存在则校验（部分版本可能未发布，跳过并提示）
if curl -fsL --retry 1 -o "$TMP/SHA256SUMS" "$BASE/v$VERSION/SHA256SUMS"; then
  (cd "$TMP" && grep " $TARBALL\$" SHA256SUMS | shasum -a 256 -c -) || { echo "sha256 校验失败" >&2; exit 1; }
else
  echo "⚠ Releases 无 SHA256SUMS，跳过校验"
fi

rm -rf "$ENGINE_DIR"
mkdir -p "$ENGINE_DIR"
tar -xzf "$TMP/$TARBALL" --strip-components=1 -C "$ENGINE_DIR"
echo "→ 解压完成: $ENGINE_DIR"
ls "$ENGINE_DIR/bin" || { echo "解压产物缺 bin/（布局变化？）" >&2; exit 1; }
echo "✓ engine ready（engine/ 已 gitignore，勿提交）"
