// electron/tests/compaction/prompt.test.ts
//
// 验证结构化摘要模板（spec §4.1）：
//   - 无 prior 模式：含 <conversation> 包裹、五节模板全名、terse 要点规则、
//     「保留精确标识符」规则、**勿提及摘要过程本身** 规则
//   - 有 prior 模式：含 <prior-summary> 包裹 + 合并指令（冲突以对话为准 / 完成项搬家 / 用户指令与决策必须携带）
//
// 保真度要点：
//   - 五节顺序固定（目标 → 重要细节 → 工作状态 → 下一步 → 相关文件）
//   - 「勿提及」是硬规则而非建议——压缩产出的摘要绝对不应被 agent
//     当作「我刚才压缩了对话」类的元信息二次泄露到上下文
//   - prior 合并指令含「冲突以对话为准」「完成项搬家」「用户指令与决策必须携带」三句话（spec §4.1 逐字）

import { describe, it, expect } from 'vitest';
import { buildCompactionPrompt } from '../../src/main/compaction/prompt';

describe('buildCompactionPrompt - 无 prior 模式（spec §4.1）', () => {
  it('包含 <conversation> 包裹区', () => {
    const prompt = buildCompactionPrompt({ conversation: '用户: 你好\n助手: 你好' });
    expect(prompt).toMatch(/<conversation>/);
    expect(prompt).toMatch(/<\/conversation>/);
    expect(prompt).toContain('用户: 你好');
  });

  it('包含五节模板全名（目标 / 重要细节 / 工作状态 / 下一步 / 相关文件）', () => {
    const prompt = buildCompactionPrompt({ conversation: '...' });
    expect(prompt).toContain('## 目标');
    expect(prompt).toContain('## 重要细节');
    expect(prompt).toContain('## 工作状态');
    expect(prompt).toContain('## 下一步');
    expect(prompt).toContain('## 相关文件');
  });

  it('「工作状态」节内含三子节（已完成 / 进行中 / 阻塞）', () => {
    const prompt = buildCompactionPrompt({ conversation: '...' });
    expect(prompt).toMatch(/## 工作状态[\s\S]*### 已完成/);
    expect(prompt).toMatch(/## 工作状态[\s\S]*### 进行中/);
    expect(prompt).toMatch(/## 工作状态[\s\S]*### 阻塞/);
  });

  it('含 terse 要点规则（不允许长段落）', () => {
    const prompt = buildCompactionPrompt({ conversation: '...' });
    expect(prompt).toMatch(/terse|要点|简洁/);
  });

  it('含「保留精确标识符」规则（路径 / 符号 / 命令 / 错误串）', () => {
    const prompt = buildCompactionPrompt({ conversation: '...' });
    // spec §4.1: 保留精确文件路径/符号/命令/错误串
    expect(prompt).toMatch(/路径|符号|命令|错误串/);
  });

  it('含「勿提及摘要过程本身」硬规则', () => {
    const prompt = buildCompactionPrompt({ conversation: '...' });
    // spec §4.1: 勿提及摘要过程本身
    expect(prompt).toMatch(/勿提及|不要提及|不要描述/);
  });

  it('五节顺序固定：目标 → 重要细节 → 工作状态 → 下一步 → 相关文件', () => {
    const prompt = buildCompactionPrompt({ conversation: '...' });
    const idx = (re: RegExp) => prompt.search(re);
    const order = [
      idx(/## 目标/),
      idx(/## 重要细节/),
      idx(/## 工作状态/),
      idx(/## 下一步/),
      idx(/## 相关文件/),
    ];
    order.forEach((v) => expect(v).toBeGreaterThan(-1));
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1]!;
      const cur = order[i]!;
      expect(cur).toBeGreaterThan(prev);
    }
  });
});

describe('buildCompactionPrompt - 有 prior 模式（spec §4.1 滚动合并）', () => {
  it('包含 <prior-summary> 包裹区', () => {
    const prompt = buildCompactionPrompt({
      conversation: '用户: 你好',
      previousSummary: '## 目标\n让用户登录',
    });
    expect(prompt).toMatch(/<prior-summary>/);
    expect(prompt).toMatch(/<\/prior-summary>/);
    expect(prompt).toContain('## 目标\n让用户登录');
  });

  it('同时保留 <conversation> 块（prior 与 conversation 共存）', () => {
    const prompt = buildCompactionPrompt({
      conversation: '用户: 新对话',
      previousSummary: '旧摘要',
    });
    expect(prompt).toMatch(/<prior-summary>/);
    expect(prompt).toMatch(/<conversation>/);
  });

  it('含「冲突以对话为准」合并指令', () => {
    const prompt = buildCompactionPrompt({
      conversation: '...',
      previousSummary: '...',
    });
    expect(prompt).toMatch(/冲突.{0,4}对话为准|以对话为准/);
  });

  it('含「完成项搬家」指令（已完成的事从对话归入摘要）', () => {
    const prompt = buildCompactionPrompt({
      conversation: '...',
      previousSummary: '...',
    });
    expect(prompt).toMatch(/完成项搬家|完成项.{0,6}搬|已完成.{0,6}合并/);
  });

  it('含「用户指令与决策必须携带」指令（不得遗漏）', () => {
    const prompt = buildCompactionPrompt({
      conversation: '...',
      previousSummary: '...',
    });
    expect(prompt).toMatch(/用户指令|决策|必须携带/);
  });
});

describe('buildCompactionPrompt - 边界', () => {
  it('空 conversation 仍能生成模板（不抛错）', () => {
    expect(() => buildCompactionPrompt({ conversation: '' })).not.toThrow();
  });

  it('空 previousSummary 等同无 prior 模式（不输出 prior 块）', () => {
    const prompt = buildCompactionPrompt({
      conversation: '...',
      previousSummary: '',
    });
    expect(prompt).not.toMatch(/<prior-summary>/);
  });

  it('undefined previousSummary 不输出 prior 块（防御空字符串边界）', () => {
    const prompt = buildCompactionPrompt({ conversation: '...' });
    expect(prompt).not.toMatch(/<prior-summary>/);
  });
});
