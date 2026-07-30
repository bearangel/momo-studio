#!/usr/bin/env bash
# 测试单个 LLM 供应商是否能调通
# 用法: ./scripts/test-llm.sh <provider> <model> <baseUrl> <apiKey>
# 示例:
#   ./scripts/test-llm.sh openai glm-5.2 https://open.bigmodel.cn/api/coding/paas/v4 YOUR_KEY
#   ./scripts/test-llm.sh openai gpt-4o "" sk-xxx
#   ./scripts/test-llm.sh anthropic claude-3-5-sonnet "" sk-ant-xxx
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20

cd "$(dirname "$0")/.."

PROVIDER="${1:?用法: test-llm.sh <provider> <model> <baseUrl> <apiKey>}"
MODEL="${2:?缺少 model 参数}"
BASE_URL="${3:-}"
API_KEY="${4:?缺少 apiKey 参数}"

echo "🤖 测试 LLM: provider=$PROVIDER model=$MODEL baseUrl=${BASE_URL:-'(默认)'}"

npx tsx -e "
import { createLLMProvider } from './electron/src/main/agent/llm-provider';

async function main() {
  const provider = createLLMProvider(
    { provider: '$PROVIDER' as any, model: '$MODEL', baseUrl: '$BASE_URL' || undefined },
    '$API_KEY',
  );

  console.log('发送请求...');
  const response = await provider.chat([
    { role: 'system', content: '你是一个测试助手。' },
    { role: 'user', content: '回复\"LLM 连接成功\"五个字' },
  ]);

  console.log('✅ 回复:', response.content);
  console.log('✅ finishReason:', response.finishReason);
  console.log('✅ toolCalls:', response.toolCalls.length);
}

main().catch(err => {
  console.error('❌ 失败:', err.message);
  process.exit(1);
});
"
