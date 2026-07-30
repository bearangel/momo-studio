#!/usr/bin/env bash
set -euo pipefail
if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; nvm use 20 2>/dev/null || nvm use 22 2>/dev/null || true; fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then echo "❌ 需要 Node 20+"; exit 1; fi

PROVIDER="${1:?用法: test-llm.sh <provider> <model> <baseUrl> <apiKey>}"
MODEL="${2:?缺少 model}"
BASE_URL="${3:-}"
API_KEY="${4:?缺少 apiKey}"

cd "$(dirname "$0")/.."
echo "🤖 测试 LLM: provider=$PROVIDER model=$MODEL baseUrl=${BASE_URL:-'(默认)'}"

npx tsx -e "
import { createLLMProvider } from './electron/src/main/agent/llm-provider';
async function main() {
  const p = createLLMProvider(
    { provider: '$PROVIDER' as any, model: '$MODEL', baseUrl: '$BASE_URL' || undefined },
    '$API_KEY',
  );
  console.log('发送请求...');
  const r = await p.chat([
    { role: 'system', content: '你是一个测试助手。' },
    { role: 'user', content: '回复\"LLM 连接成功\"五个字' },
  ]);
  console.log('✅ 回复:', r.content);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
"
