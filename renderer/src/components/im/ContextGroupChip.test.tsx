// ContextGroupChip 单测：计数文案（N 次读取 · M 次搜索）+ 展开单行摘要 + 执行中态。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextGroupChip } from './ContextGroupChip';
import type { ContextGroup } from '../../lib/group-tool-segments';

function item(callId: string, toolName: string, over?: Partial<{ result: string | null; success: boolean | null }>) {
  return {
    kind: 'tool_call' as const,
    callId,
    toolName,
    args: toolName === 'read_file' ? { path: `src/${callId}.ts` } : { pattern: '*.ts' },
    result: 'ok',
    success: true,
    ...over,
  };
}

describe('ContextGroupChip', () => {
  it('折叠行显示「收集上下文」+ 分项计数', () => {
    const group: ContextGroup = {
      kind: 'context-group',
      items: [item('c1', 'read_file'), item('c2', 'read_file'), item('c3', 'grep')],
    };
    render(<ContextGroupChip group={group} />);
    expect(screen.getByText('收集上下文')).toBeInTheDocument();
    expect(screen.getByText(/2 次读取 · 1 次搜索/)).toBeInTheDocument();
  });

  it('展开后每条单行摘要（无嵌套手风琴）', () => {
    const group: ContextGroup = {
      kind: 'context-group',
      items: [item('c1', 'read_file'), item('c2', 'glob')],
    };
    render(<ContextGroupChip group={group} />);
    fireEvent.click(screen.getByText('收集上下文'));
    expect(screen.getByText('c1.ts')).toBeInTheDocument(); // describeToolCall 文件名摘要
    expect(screen.getAllByRole('button')).toHaveLength(1); // 只有折叠头一个按钮
  });

  it('有未完成项时显示执行中 warning tint', () => {
    const group: ContextGroup = {
      kind: 'context-group',
      items: [item('c1', 'read_file'), item('c2', 'read_file', { result: null, success: null })],
    };
    const { container } = render(<ContextGroupChip group={group} />);
    expect(container.querySelector('button')?.classList.contains('bg-status-warning-tint')).toBe(true);
  });
});
