// renderer/src/components/im/ToolCallChip.test.tsx
// ToolCallChip 渲染行为：工具名/参数摘要 + 状态图标（⏳/✓/✗）+ 耗时 + 点击展开详情。
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

  it('成功状态显示 ✓ 和耗时', () => {
    render(<ToolCallChip toolName="read_file" args={{}} success={true} durationMs={120} />);
    expect(screen.getByText(/✓/)).toBeInTheDocument();
    expect(screen.getByText(/120ms/)).toBeInTheDocument();
  });

  it('失败状态显示 ✗', () => {
    render(<ToolCallChip toolName="write_file" args={{}} success={false} />);
    expect(screen.getByText(/✗/)).toBeInTheDocument();
  });

  it('执行中状态显示 ⏳', () => {
    render(<ToolCallChip toolName="list_files" args={{}} success={true} isExecuting={true} />);
    expect(screen.getByText(/⏳/)).toBeInTheDocument();
  });

  it('点击展开显示参数和结果', () => {
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
    fireEvent.click(screen.getByText('read_file'));
    // 展开后渲染
    expect(screen.getByText(/file content/)).toBeInTheDocument();
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
    render(
      <ToolCallChip toolName="read_file" args={{ path: 'a.ts' }} success={true} defaultExpanded={true} />,
    );
    expect(screen.queryByText(/^结果/)).not.toBeInTheDocument();
  });
});
