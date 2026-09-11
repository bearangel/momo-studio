// electron/tests/browser/selector.test.ts
//
// selector 解析器纯函数测试（spec §3.3 四语法表）：前缀拆分 / 无前缀=css / 非法与
// 纯前缀输入 / 值内 `=` 不误拆。buildResolveScript 产出注入页内的脚本源码——纯 Node
// 无 DOM，此处断言结构性标记（选择器值经 JSON 转义内嵌、按 kind 分派到对应 DOM API、
// 末尾 JSON.stringify 返回）；真实 DOM 匹配行为由 e2e（T11）与 macOS 主机验收覆盖。
import { describe, expect, it } from 'vitest';
import { BrowserSelectorError } from '../../src/main/browser/errors';
import { buildResolveScript, parseAriaClauses, parseSelector } from '../../src/main/browser/selector';

describe('parseSelector 四语法拆分', () => {
  it('text= / xpath= / aria/ 三前缀正确拆出 kind 与 value', () => {
    expect(parseSelector('text=登录')).toEqual({ kind: 'text', value: '登录' });
    expect(parseSelector('xpath=//button[@type="submit"]')).toEqual({
      kind: 'xpath',
      value: '//button[@type="submit"]',
    });
    expect(parseSelector('aria/[role="button"][name="提交"]')).toEqual({
      kind: 'aria',
      value: '[role="button"][name="提交"]',
    });
  });

  it('无前缀 = css；css: 前缀剥离（§3.4 snapshot 提示行可直接复制进 click）', () => {
    expect(parseSelector('.btn-primary')).toEqual({ kind: 'css', value: '.btn-primary' });
    expect(parseSelector('#go')).toEqual({ kind: 'css', value: '#go' });
    expect(parseSelector('div > p')).toEqual({ kind: 'css', value: 'div > p' });
    expect(parseSelector('css:[placeholder="you@example.com"]')).toEqual({
      kind: 'css',
      value: '[placeholder="you@example.com"]',
    });
  });

  it('aria 不带 / 的裸形态按 css 处理（合法 css 类型选择器）', () => {
    expect(parseSelector('aria')).toEqual({ kind: 'css', value: 'aria' });
  });

  it('空值与纯前缀 → BrowserSelectorError', () => {
    for (const bad of ['', '   ', '\t', 'text=', 'xpath=', 'aria/', 'css:', 'text=   ']) {
      expect(() => parseSelector(bad)).toThrow(BrowserSelectorError);
    }
  });

  it('值内含 `=` 不误拆：首个 = 即分隔符，text=a=b 取 a=b', () => {
    expect(parseSelector('text=a=b')).toEqual({ kind: 'text', value: 'a=b' });
    expect(parseSelector('xpath=//a[@href="x=y"]')).toEqual({
      kind: 'xpath',
      value: '//a[@href="x=y"]',
    });
  });
});

describe('parseAriaClauses（aria 值的 role/name 子句解析，纯 TS 侧）', () => {
  it('[role="x"][name="y"] 拆出两组子句', () => {
    expect(parseAriaClauses('[role="button"][name="提交"]')).toEqual([
      { key: 'role', val: 'button' },
      { key: 'name', val: '提交' },
    ]);
  });

  it('单引号与不带引号子句均支持；空值/未知键跳过', () => {
    expect(parseAriaClauses("[name='登录']")).toEqual([{ key: 'name', val: '登录' }]);
    expect(parseAriaClauses('[role=button]')).toEqual([{ key: 'role', val: 'button' }]);
    expect(parseAriaClauses('[role=""][aria-label="x"]')).toEqual([]);
  });
});

describe('buildResolveScript 页内脚本结构', () => {
  it('kind/value 经 JSON 转义内嵌（防注入）；末尾 JSON.stringify 返回 JSON 串', () => {
    const src = buildResolveScript({ kind: 'css', value: '.btn"q\\x' });
    expect(src).toContain(`const VALUE = ${JSON.stringify('.btn"q\\x')};`);
    expect(src).toContain('JSON.stringify');
    // IIFE 自含——executeJavaScript 取其完成值
    expect(src.trim().startsWith('(() =>')).toBe(true);
    expect(src.trim().endsWith('})()')).toBe(true);
  });

  it('css 分派 document.querySelector；text 分派文本节点遍历（取可交互祖先）', () => {
    const css = buildResolveScript({ kind: 'css', value: '#go' });
    expect(css).toContain('document.querySelector');
    const text = buildResolveScript({ kind: 'text', value: '登录' });
    expect(text).toContain('createTreeWalker');
    expect(text).toContain('SHOW_TEXT');
    expect(text).toContain('parentElement');
  });

  it('xpath 分派 document.evaluate；aria 接收预解析的 role/name 子句', () => {
    const xpath = buildResolveScript({ kind: 'xpath', value: '//button' });
    expect(xpath).toContain('document.evaluate');
    const aria = buildResolveScript({ kind: 'aria', value: '[role="button"][name="提交"]' });
    expect(aria).toContain(
      `const ARIA = ${JSON.stringify([{ key: 'role', val: 'button' }, { key: 'name', val: '提交' }])};`,
    );
  });

  it('未命中路径收集可交互元素前 5（hints 字段随 rect:null 一起返回）', () => {
    const src = buildResolveScript({ kind: 'css', value: '.missing' });
    expect(src).toContain('hints');
    expect(src).toContain('5');
    expect(src).toContain('rect: null');
  });
});
