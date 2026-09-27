#!/usr/bin/env bash
# scripts/test-llm.sh — 直连验证一个 LLM 供应商配置（不经 UI / 不落库）
# 用法: ./scripts/test-llm.sh <provider> <model> [baseUrl] <apiKey>
#   provider: openai | anthropic（缺省按 baseUrl 启发式检测）
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/common.sh
momo_require_node20
momo_require_deps

PROVIDER="${1:?用法: test-llm.sh <openai|anthropic> <model> [baseUrl] <apiKey>}"
MODEL="${2:?缺少 model}"
BASE_URL="${3:-}"
API_KEY="${4:?缺少 apiKey}"

echo "🤖 测试 LLM: provider=$PROVIDER model=$MODEL baseUrl=${BASE_URL:-'(默认)'}"

# 参数经环境变量传入（shell 直拼 tsx 字符串有引号/注入风险）
LLM_PROVIDER="$PROVIDER" LLM_MODEL="$MODEL" LLM_BASE_URL="$BASE_URL" LLM_API_KEY="$API_KEY" \
npx tsx -e "
import { createLLMProvider } from './electron/src/main/agent/llm-provider';

const raw = process.env.LLM_PROVIDER;
const provider = raw === 'openai' || raw === 'anthropic' ? raw : undefined;
const baseUrl = process.env.LLM_BASE_URL || undefined;

async function main() {
  const p = createLLMProvider(
    { provider, model: process.env.LLM_MODEL as string, baseUrl },
    process.env.LLM_API_KEY as string,
  );
  console.log('发送请求...');
  const r = await p.chat([
    { role: 'system', content: '你是一个测试助手。' },
    { role: 'user', content: '回复\"LLM 连接成功\"五个字' },
  ]);
  console.log('✅ 回复:', r.content);
}
main().catch((e: Error) => { console.error('❌', e.message); process.exit(1); });
"
