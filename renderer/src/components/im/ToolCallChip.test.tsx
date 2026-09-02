// renderer/src/components/im/ToolCallChip.test.tsx
// ToolCallChip 渲染行为：工具名/参数摘要 + 状态图标（lucide 三态）+ 耗时 + 点击展开详情。
// v2.1：⏳/✓/✗ 字形断言退役，按 svg.lucide-* / 三态 tint class 语义断言。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallChip } from './ToolCallChip';

describe('ToolCallChip', () => {
  it('渲染工具名和参数摘要', () => {
    render(
      <ToolCallChip toolName="read_file" args={{ path: 'src/index.ts' }} success={true} durationMs={120} />,
    );
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText(/src\/index\.ts/)).toBeInTheDocument();
  });

  it('成功状态渲染 CircleCheck 图标 + success tint + 耗时', () => {
    const { container } = render(
      <ToolCallChip toolName="read_file" args={{}} success={true} durationMs={120} />,
    );
    expect(container.querySelector('svg.lucide-circle-check')).not.toBeNull();
    expect(screen.getByRole('button').classList.contains('bg-status-success-tint')).toBe(true);
    expect(screen.getByText(/120ms/)).toBeInTheDocument();
  });

  it('失败状态渲染 CircleX 图标 + error tint', () => {
    const { container } = render(<ToolCallChip toolName="write_file" args={{}} success={false} />);
    expect(container.querySelector('svg.lucide-circle-x')).not.toBeNull();
    expect(screen.getByRole('button').classList.contains('bg-status-error-tint')).toBe(true);
  });

  it('执行中状态渲染 Loader2 旋转图标 + warning tint', () => {
    const { container } = render(
      <ToolCallChip toolName="list_files" args={{}} success={true} isExecuting={true} />,
    );
    // lucide 1.x 中 Loader2 是 LoaderCircle 的别名，svg class 为 lucide-loader-circle
    const spinner = container.querySelector('svg.lucide-loader-circle');
    expect(spinner).not.toBeNull();
    expect(spinner?.classList.contains('animate-spin')).toBe(true);
    expect(screen.getByRole('button').classList.contains('bg-status-warning-tint')).toBe(true);
    expect(screen.getByText(/执行中/)).toBeInTheDocument();
  });

  it('点击展开显示参数和结果（aria-expanded 翻转）', () => {
    render(
      <ToolCallChip
        toolName="read_file"
        args={{ path: 'a.ts' }}
        result="file content"
        success={true}
      />,
    );
    // 默认折叠——结果未渲染
    expect(screen.queryByText(/file content/)).not.toBeInTheDocument();
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByText('read_file'));
    // 展开后渲染
    expect(screen.getByText(/file content/)).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('defaultExpanded=true 时默认展开', () => {
    render(
      <ToolCallChip
        toolName="read_file"
        args={{ path: 'a.ts' }}
        result="hello"
        success={true}
        defaultExpanded={true}
      />,
    );
    // 不点击也能看到结果
    expect(screen.getByText(/hello/)).toBeInTheDocument();
  });

  it('无 result 时不渲染结果行', () => {
    render(<ToolCallChip toolName="read_file" args={{ path: 'a.ts' }} success={true} defaultExpanded={true} />);
    expect(screen.queryByText(/^结果/)).not.toBeInTheDocument();
  });
});
