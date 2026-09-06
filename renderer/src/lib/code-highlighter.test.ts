// code-highlighter 单测：语言归一 + 真实 shiki 冒烟（本地 bundle，无网络）。
import { describe, it, expect } from 'vitest';
import { highlightCode, resolveLang } from './code-highlighter';

describe('resolveLang', () => {
  it('别名归一：ts → typescript', () => {
    expect(resolveLang('ts')).toEqual({ kind: 'highlight', id: 'typescript' });
  });
  it('shell 类围栏返回 shell（降饱和路径）', () => {
    expect(resolveLang('bash')).toEqual({ kind: 'shell' });
    expect(resolveLang('console')).toEqual({ kind: 'shell' });
  });
  it('大小写与首尾空格不敏感', () => {
    expect(resolveLang(' Bash ')).toEqual({ kind: 'shell' });
  });
  it('白名单外语言返回 plain', () => {
    expect(resolveLang('cobol')).toEqual({ kind: 'plain' });
  });
});

describe('highlightCode（真实 shiki 冒烟）', () => {
  it('ts 代码返回含 --shiki-dark 变量的 html（双主题一次产出）', async () => {
    const html = await highlightCode('const a = 1', 'ts');
    expect(html).toBeDefined();
    expect(html).toContain('--shiki-dark');
  });
  it('shell / plain 返回 undefined（调用方走纯文本）', async () => {
    expect(await highlightCode('ls -la', 'bash')).toBeUndefined();
    expect(await highlightCode('x', 'brainfuck')).toBeUndefined();
  });
});
