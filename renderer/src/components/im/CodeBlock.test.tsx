// CodeBlock 单测：语言标签行 / 无语言降级 / shell 降饱和 / deferHighlight 纯文本。
// highlightCode 模块 mock（组件契约：调用它并注入返回 html；真实行为由
// code-highlighter.test.ts 冒烟覆盖——两层各自测自己的契约）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';
import { highlightCode } from '../../lib/code-highlighter';

vi.mock('../../lib/code-highlighter', () => ({
  highlightCode: vi.fn().mockResolvedValue('<pre class="shiki"><code>hi</code></pre>'),
  SHELL_LANGS: new Set(['bash', 'sh', 'zsh', 'shell', 'console']),
}));

const mockedHighlight = vi.mocked(highlightCode);

describe('CodeBlock', () => {
  it('渲染语言标签行', () => {
    render(<CodeBlock code="const a = 1" lang="ts" />);
    expect(screen.getByText('ts')).toBeInTheDocument();
  });

  it('无语言标注时不渲染标签行', () => {
    const { container } = render(<CodeBlock code="plain" lang="" />);
    // 容器第一层 div 是标签行位置——无语言时不存在
    expect(container.querySelector('.md-codeblock > div')).toBeNull();
  });

  it('可高亮语言异步注入 shiki html', async () => {
    const { container } = render(<CodeBlock code="const a = 1" lang="ts" />);
    await waitFor(() => {
      expect(container.querySelector('.shiki')).not.toBeNull();
    });
    expect(mockedHighlight).toHaveBeenCalledWith('const a = 1', 'ts');
  });

  it('shell 语言不调用高亮（降饱和纯文本）', () => {
    mockedHighlight.mockClear();
    render(<CodeBlock code="git status" lang="bash" />);
    expect(mockedHighlight).not.toHaveBeenCalled();
    expect(screen.getByText('git status')).toBeInTheDocument();
  });

  it('deferHighlight=true 时不调用高亮（流式期间纯文本）', () => {
    mockedHighlight.mockClear();
    render(<CodeBlock code="const a" lang="ts" deferHighlight={true} />);
    expect(mockedHighlight).not.toHaveBeenCalled();
    expect(screen.getByText('const a')).toBeInTheDocument();
  });
});
