// electron/tests/storage/text-hygiene.test.ts
//
// F3 回归锁：stripHiddenContext 剥离 <secrecy> 隐藏上下文。
// 症状（2026-09-18 实测会话）：模型私有规划块（含工具预算等内部策略）原样
// 出现在用户可见消息与导出里。契约：完整块 + 未闭合尾段都剥离；无标签文本
// 原样透传；renderer/src/lib/text-hygiene.ts 是本函数的镜像实现，双侧语义
// 必须一致（镜像测试同款断言）。
import { describe, it, expect } from 'vitest';
import { stripHiddenContext } from '../../src/main/storage/messages/text-hygiene';

describe('stripHiddenContext', () => {
  it('无标签文本原样透传（快速路径）', () => {
    const text = '普通正文，含 XML 词汇 <task> 但无 secrecy 标签。';
    expect(stripHiddenContext(text)).toBe(text);
  });

  it('完整块剥离，块前正文保留', () => {
    const text = '开始执行。\n<secrecy>工具预算 50 次，累计约 25 次</secrecy>\n第三轮开始。';
    const out = stripHiddenContext(text);
    expect(out).toContain('开始执行。');
    expect(out).toContain('第三轮开始。');
    expect(out).not.toContain('secrecy');
    expect(out).not.toContain('工具预算');
  });

  it('多个完整块全部剥离', () => {
    const text = 'A<secrecy>一</secrecy>B<secrecy>二</secrecy>C';
    expect(stripHiddenContext(text)).toBe('ABC');
  });

  it('未闭合尾段剥离（流式中途——开标签起全部隐藏）', () => {
    const text = '正文。<secrecy>正在写的私有规划';
    const out = stripHiddenContext(text);
    expect(out).toBe('正文。');
  });

  it('跨行块（含换行与 markdown）剥离', () => {
    const text = '前文\n<secrecy>\n用户要求进行第三轮：\n- 计划 A\n- 计划 B\n</secrecy>\n后文';
    const out = stripHiddenContext(text);
    expect(out).toContain('前文');
    expect(out).toContain('后文');
    expect(out).not.toContain('第三轮');
  });

  it('仅剩块时结果为空串（不残留空白尾巴语义变化由消费方自理）', () => {
    expect(stripHiddenContext('<secrecy>x</secrecy>')).toBe('');
  });
});
