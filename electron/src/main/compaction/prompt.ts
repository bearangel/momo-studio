// electron/src/main/compaction/prompt.ts
//
// 结构化摘要模板（spec §4.1，opencode 式中文化）：
//   - 五节固定模板：目标 / 重要细节 / 工作状态（已完成·进行中·阻塞）/ 下一步 / 相关文件
//   - 规则三条：terse 要点、保留精确路径/符号/命令/错误串、勿提及摘要过程本身
//   - prior 滚动合并：<prior-summary> 包裹 + 合并指令三句（冲突以对话为准 /
//     完成项搬家 / 用户指令与决策必须携带）
//
// 纯函数：零 DB/IPC 副作用；调用方负责把已序列化 conversation 字符串与
// prior 摘要传入。失败/空响应由上游 llm.chat 的失败路径处理。

/** prior 合并指令——三句固定措辞（spec §4.1 逐字） */
const PRIOR_MERGE_INSTRUCTIONS = [
  '冲突以对话为准。',
  '已完成项从对话中搬家到「已完成」。',
  '用户指令与决策必须从 prior 摘要与对话中全部携带到新摘要，不得遗漏。',
] as const;

/** 五节模板骨架——空节填「(无)」避免 LLM 凭空补内容 */
const SECTION_SKELETON = `## 目标
(无)

## 重要细节
(无)

## 工作状态

### 已完成
(无)

### 进行中
(无)

### 阻塞
(无)

## 下一步
(无)

## 相关文件
(无)`;

/** 规则三条（spec §4.1） */
const RULES_BLOCK = [
  '## 写作规则',
  '- 使用 terse 要点列表；禁止长段落。',
  '- 必须保留精确文件路径、函数符号、命令、错误串——便于后续回合直接复用。',
  '- **勿提及摘要过程本身**（不要写「压缩了对话」「以下是基于历史」之类元信息）。',
].join('\n');

/**
 * 构造压缩 LLM 请求 prompt。
 *
 * - 无 prior：直接包 conversation，附五节骨架 + 规则
 * - 有 prior：先包 prior，再包 conversation，附「合并指令三句」+ 规则
 *
 * @param input.conversation 序列化好的对话（serializeMessages 产出）
 * @param input.previousSummary 上次压缩产出的结构化摘要；空/undefined 视为无 prior
 */
export function buildCompactionPrompt(input: {
  conversation: string;
  previousSummary?: string;
}): string {
  const { conversation, previousSummary } = input;
  const hasPrior = typeof previousSummary === 'string' && previousSummary.length > 0;

  const header = hasPrior
    ? buildPriorHeader(previousSummary)
    : '请基于以下对话生成结构化摘要。\n';

  return [
    '你是结构化对话摘要助手。',
    '',
    header,
    '<conversation>',
    conversation,
    '</conversation>',
    '',
    '请按下方五节模板输出摘要：',
    '',
    SECTION_SKELETON,
    '',
    RULES_BLOCK,
  ].join('\n');
}

/**
 * prior 模式头部：合并指令三句（spec §4.1 逐字）+ <prior-summary> 包裹。
 */
function buildPriorHeader(previousSummary: string): string {
  return [
    '下面是已有的摘要与新的对话片段，请滚动合并：',
    '',
    ...PRIOR_MERGE_INSTRUCTIONS,
    '',
    '<prior-summary>',
    previousSummary,
    '</prior-summary>',
    '',
    '<conversation>',
  ].join('\n');
}
