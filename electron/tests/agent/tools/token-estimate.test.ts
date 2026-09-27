// electron/tests/agent/tools/token-estimate.test.ts
//
// 验证中文混合系数 token 估算：
//   - CJK 字符 ÷1.6，其余 ÷4，向上取整（spec §3）
//   - estimateConversation 串行汇总 system + messages + tools
//   - 含 1 个工具定义时 token 数严格大于空 tools（单调递增——不允许偶然相等）
//   - 三个 COMPACTION_* 常量透出（子进程与主进程共享同一份真理源）
//
// 保真度要点（momo-test-rules）：
//   - 既要锁定数值，也要锁定「区间」语义（混合样例的具体系数取决于
//     空格/标点如何归类；spec 给的是"中文混合系数"，故锁定宽松上下界）
//   - estimateConversation 用真实 LLMMessage（从 llm-provider.ts 导入），
//     不造简化 fixture——任何字段（toolCalls / toolCallId）变化时此测试
//     必须强制更新

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateConversation,
  estimateImageTokens,
  COMPACTION_BUFFER_TOKENS,
  COMPACTION_KEEP_TOKENS,
  COMPACTION_MIN_TRIGGER,
} from '../../../src/main/agent/tools/shared/token-estimate';
import type { LLMMessage } from '../../../src/main/agent/llm-provider';

describe('estimateTokens - 中文混合系数（spec §3）', () => {
  it('① 纯中文 10 个 CJK 字符「一二三四五六七八九十」⌈10/1.6⌉=7', () => {
    // 每个字都在 CJK Unified Ideographs U+4E00-9FFF 中
    expect(estimateTokens('一二三四五六七八九十')).toBe(7);
  });

  it('② 纯英文 40 字符 ⌈40/4⌉=10', () => {
    const text = 'a'.repeat(40);
    expect(estimateTokens(text)).toBe(10);
  });

  it('③ 中英混合样例锁定区间（"Hello 你好 world 世界"）', () => {
    // 字符拆解：H,e,l,l,o,space, 你,好,space, w,o,r,l,d,space, 世,界 = 17
    // CJK: 你好世界 = 4 → 4/1.6 = 2.5
    // 非 CJK: 13（5 letters + 5 letters + 3 spaces）→ 13/4 = 3.25
    // 合计 ≈ 5.75，向上取整 = 6
    // 锁定区间 [5, 7] 容纳不同 CJK 字符集定义（保守上下界）
    const result = estimateTokens('Hello 你好 world 世界');
    expect(result).toBeGreaterThanOrEqual(5);
    expect(result).toBeLessThanOrEqual(7);
  });

  it('空字符串返回 0（baseline）', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯标点/空白按"其余"系数 ÷4', () => {
    // 5 个空格 → ⌈5/4⌉ = 2（向上取整，0.25 也算 1 票）
    expect(estimateTokens('     ')).toBe(2);
  });
});

describe('estimateConversation - 串行汇总（spec §3）', () => {
  it('空 messages + 空 system 返回 0', () => {
    expect(
      estimateConversation({ system: '', messages: [], tools: [] }),
    ).toBe(0);
  });

  it('④ 含 1 个工具定义时 token 数严格大于空 tools（单调递增）', () => {
    const base = {
      system: '你是助手',
      messages: [
        { role: 'user' as const, content: '你好' },
        { role: 'assistant' as const, content: '你好！有什么可以帮你的？' },
      ],
    };

    const withoutTools = estimateConversation({ ...base, tools: [] });
    const withOneTool = estimateConversation({
      ...base,
      tools: [
        {
          name: 'search',
          description: '搜索工具',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    });

    // 工具定义占 token：严格大于（含 1 个即 > 空）
    expect(withOneTool).toBeGreaterThan(withoutTools);
  });

  it('system + user + assistant 文本被完整计入', () => {
    // system「你是智能助手」6 CJK + user「你好」2 CJK + assistant「你好世界欢迎光临」8 CJK = 16 CJK
    // 16/1.6 = 10 → ceil 10；每段分别 ceil 后求和 = 4+2+5 = 11
    const messages: LLMMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好世界欢迎光临' },
    ];
    const result = estimateConversation({ system: '你是智能助手', messages, tools: [] });
    // system 必须被计入（≥3 段各自至少 1 token 的下界）；断言值 ≤ 真实估算 + 余量
    expect(result).toBeGreaterThanOrEqual(10);
    expect(result).toBeLessThanOrEqual(12);
  });

  it('assistant 带 toolCalls 时，工具参数 JSON 计入 token', () => {
    // 文本部分 + toolCalls.arguments（JSON 序列化后计入）
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'lookup',
            arguments: { path: '/very/long/path/to/some/file/that/exists/here.txt' },
          },
        ],
      },
    ];
    const tokens = estimateConversation({ system: '', messages, tools: [] });
    // 路径 50 字符（非 CJK）→ 50/4 = 12.5 → ceil 13；name 'lookup' 也计入
    expect(tokens).toBeGreaterThanOrEqual(13);
  });
});

describe('estimateImageTokens - 图片 token 估算（spec 2026-09-26-image-input §9）', () => {
  it('典型 2048×1536：⌈3145728/750⌉=⌈4194.304⌉=4195', () => {
    expect(estimateImageTokens(2048, 1536)).toBe(4195);
  });

  it('小图触发 258 下限：10×10 → max(258, ⌈0.133…⌉)=258', () => {
    expect(estimateImageTokens(10, 10)).toBe(258);
  });

  it('极端长条触发下限：750×1 → max(258, 1)=258', () => {
    expect(estimateImageTokens(750, 1)).toBe(258);
  });
});

describe('estimateConversation - images 累加（spec 2026-09-26-image-input §9）', () => {
  it('带 2 张图片的消息：文本 + 两图逐张累加（数值精确锁定）', () => {
    // 文本 'hello' 5 非 CJK → ⌈5/4⌉=2；system 空 → 0
    // 图1 2048×1536 → 4195；图2 1024×1024 → ⌈1048576/750⌉=⌈1398.101…⌉=1399
    // 总计 2 + 4195 + 1399 = 5596
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: 'hello',
        images: [
          { mime: 'image/png', base64: '', w: 2048, h: 1536 },
          { mime: 'image/jpeg', base64: '', w: 1024, h: 1024 },
        ],
      },
    ];
    expect(estimateConversation({ system: '', messages, tools: [] })).toBe(5596);
  });

  it('无 images 的消息估算与纯文本时代 golden 值完全一致（纯加性零项）', () => {
    // golden（旧逻辑）：system 'hi' ⌈2/4⌉=1 + user 10 CJK ⌈10/1.6⌉=7 → 8
    const messages: LLMMessage[] = [
      { role: 'user', content: '一二三四五六七八九十' },
    ];
    expect(estimateConversation({ system: 'hi', messages, tools: [] })).toBe(8);
  });
});

describe('COMPACTION_* 常量（spec §3）', () => {
  it('COMPACTION_BUFFER_TOKENS = 20_000（输出预留下限）', () => {
    expect(COMPACTION_BUFFER_TOKENS).toBe(20_000);
  });
  it('COMPACTION_KEEP_TOKENS = 8_000（尾部保留预算）', () => {
    expect(COMPACTION_KEEP_TOKENS).toBe(8_000);
  });
  it('COMPACTION_MIN_TRIGGER = 4_000（估算低于此值不压）', () => {
    expect(COMPACTION_MIN_TRIGGER).toBe(4_000);
  });
});
