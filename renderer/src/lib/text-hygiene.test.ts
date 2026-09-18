// renderer/src/lib/text-hygiene.test.ts
//
// electron/tests/storage/text-hygiene.test.ts 的镜像同款断言（F3）——
// 主进程无法 import renderer 源码，双侧镜像实现靠同款测试锁语义一致。
import { describe, it, expect } from 'vitest';
import { stripHiddenContext } from './text-hygiene';

describe('stripHiddenContext（electron 侧镜像）', () => {
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
    expect(stripHiddenContext('A<secrecy>一</secrecy>B<secrecy>二</secrecy>C')).toBe('ABC');
  });

  it('未闭合尾段剥离（流式中途——开标签起全部隐藏）', () => {
    expect(stripHiddenContext('正文。<secrecy>正在写的私有规划')).toBe('正文。');
  });

  it('跨行块剥离', () => {
    const text = '前文\n<secrecy>\n用户要求进行第三轮：\n- 计划 A\n</secrecy>\n后文';
    const out = stripHiddenContext(text);
    expect(out).toContain('前文');
    expect(out).toContain('后文');
    expect(out).not.toContain('第三轮');
  });

  it('仅剩块时结果为空串', () => {
    expect(stripHiddenContext('<secrecy>x</secrecy>')).toBe('');
  });
});
