// MarkdownBody 单测：统一 components 映射——围栏代码块走 CodeBlock、行内 code
// 不误判、表格滚动容器、SafeAnchor 链接拦截。CodeBlock mock 掉（契约分层）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownBody } from './MarkdownBody';

vi.mock('./CodeBlock', () => ({
  CodeBlock: ({ code, lang }: { code: string; lang: string }) => (
    <div data-testid="codeblock" data-lang={lang}>
      {code}
    </div>
  ),
}));

describe('MarkdownBody', () => {
  it('GFM 表格包进横向滚动容器', () => {
    const { container } = render(<MarkdownBody>{'| a | b |\n|---|---|\n| 1 | 2 |'}</MarkdownBody>);
    expect(container.querySelector('.md-table-wrap table')).not.toBeNull();
  });

  it('围栏代码块走 CodeBlock 且语言正确提取', () => {
    render(<MarkdownBody>{'```ts\nconst a = 1\n```'}</MarkdownBody>);
    expect(screen.getByTestId('codeblock').dataset.lang).toBe('ts');
  });

  it('无语言围栏走 CodeBlock 且 lang 为空（不渲染标签行由 CodeBlock 保证）', () => {
    render(<MarkdownBody>{'```\nplain\n```'}</MarkdownBody>);
    expect(screen.getByTestId('codeblock').dataset.lang).toBe('');
  });

  it('行内代码不走 CodeBlock，渲染为 code 元素', () => {
    render(<MarkdownBody>{'使用 `seq` 去重'}</MarkdownBody>);
    expect(screen.queryByTestId('codeblock')).toBeNull();
    expect(screen.getByText('seq').tagName).toBe('CODE');
  });

  it('链接点击被拦截，window.open 带noopener 代跳', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MarkdownBody>{'[docs](https://example.com)'}</MarkdownBody>);
    fireEvent.click(screen.getByRole('link'));
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('deferHighlight 透传给 CodeBlock', () => {
    render(
      <MarkdownBody deferHighlight={true}>{'```ts\nconst a\n```'}</MarkdownBody>,
    );
    expect(screen.getByTestId('codeblock').textContent).toBe('const a');
  });
});
