// renderer/src/components/im/ToolCallChip.test.tsx
// ToolCallChip 单测（v2.1 重写）：摘要行（describeToolCall）+ 展开结果优先
//（默认无参数）+ 10 行折叠 + 次级参数开关 + 错误单行 + 权限拒绝降级 warning。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallChip } from './ToolCallChip';

describe('ToolCallChip — 摘要行', () => {
  it('渲染工具名 + 智能摘要（read_file 只显文件名）+ 耗时', () => {
    render(<ToolCallChip toolName="read_file" args={{ path: 'src/index.ts' }} success={true} durationMs={120} />);
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText(/120ms/)).toBeInTheDocument();
  });

  it('未知工具渲染 k=v 次要参数 chip', () => {
    render(<ToolCallChip toolName="mcp:x" args={{ description: '做事', owner: 'a', repo: 'b' }} success={true} />);
    expect(screen.getByText('做事')).toBeInTheDocument();
    expect(screen.getByText('owner=a')).toBeInTheDocument();
  });

  it('成功/失败/执行中三态 tint 与图标沿用', () => {
    const { container, unmount } = render(<ToolCallChip toolName="bash" args={{}} success={true} />);
    expect(container.querySelector('svg.lucide-circle-check')).not.toBeNull();
    expect(screen.getByRole('button').classList.contains('bg-status-success-tint')).toBe(true);
    unmount();

    const c2 = render(<ToolCallChip toolName="bash" args={{}} success={false} result="boom" />).container;
    expect(c2.querySelector('svg.lucide-circle-x')).not.toBeNull();
    expect(c2.querySelector('button')?.classList.contains('bg-status-error-tint')).toBe(true);

    // 执行中态（评审补齐）：warning tint + Loader2 旋转 + 文案
    const c3 = render(
      <ToolCallChip toolName="bash" args={{}} success={true} isExecuting={true} />,
    ).container;
    const spinner = c3.querySelector('svg.lucide-loader-circle');
    expect(spinner).not.toBeNull();
    expect(spinner?.classList.contains('animate-spin')).toBe(true);
    expect(c3.querySelector('button')?.classList.contains('bg-status-warning-tint')).toBe(true);
    expect(screen.getByText(/执行中/)).toBeInTheDocument();
  });
});

describe('ToolCallChip — 展开面板（结果优先）', () => {
  it('展开只显示结果，参数默认不渲染', () => {
    // brief 原断言 queryByText(/git status/) 在 bash 智能摘要下恒为假阳
    //（摘要行永远渲染命令值）。改断言 args JSON 的 key 不在文档——意图不变、不与摘要冲突
    render(
      <ToolCallChip toolName="bash" args={{ command: 'git status' }} result="On branch main" success={true} />,
    );
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText(/On branch main/)).toBeInTheDocument();
    expect(screen.queryByText(/"command"/)).not.toBeInTheDocument(); // args JSON 默认不在面板
  });

  it('次级「参数」开关展开后可见参数 JSON', () => {
    render(
      <ToolCallChip toolName="bash" args={{ command: 'ls' }} result="a" success={true} />,
    );
    fireEvent.click(screen.getByText('bash'));
    fireEvent.click(screen.getByText(/▸ 参数/));
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
  });

  it('结果超 10 行折叠并显示「展开剩余 N 行」', () => {
    const eleven = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    render(<ToolCallChip toolName="bash" args={{}} result={eleven} success={true} />);
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText(/展开剩余 2 行/)).toBeInTheDocument();
    expect(screen.queryByText(/line-11/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/展开剩余 2 行/));
    expect(screen.getByText(/line-11/)).toBeInTheDocument();
  });

  it('执行中展开显示等待文案', () => {
    render(<ToolCallChip toolName="bash" args={{}} success={true} isExecuting={true} defaultExpanded={true} />);
    expect(screen.getByText(/等待工具响应/)).toBeInTheDocument();
  });
});

describe('ToolCallChip — 错误态', () => {
  it('失败结果压平单行（title 悬浮看全文）', () => {
    render(
      <ToolCallChip
        toolName="grep"
        args={{}}
        result={'Error: something\n  at line 2\n  at line 3'}
        success={false}
        defaultExpanded={true}
      />,
    );
    const el = screen.getByText(/Error: something/);
    expect(el.textContent).not.toContain('\n');
    expect(el.getAttribute('title')).toContain('at line 3');
  });

  it('权限拒绝降级 warning tint + TriangleAlert 图标', () => {
    const { container } = render(
      <ToolCallChip
        toolName="write_file"
        args={{}}
        result="用户拒绝写入权限"
        success={false}
        defaultExpanded={true}
      />,
    );
    expect(container.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
    expect(container.querySelector('button')?.classList.contains('bg-status-warning-tint')).toBe(true);
  });
});
