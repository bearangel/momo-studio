// renderer/src/components/common/JournalChangeViews.test.tsx
//
// JournalChangeViews 共享呈现件测试：
//   - DiffBlock：超大 rows 全量渲染会卡死消息流（审查 C3）→ 渲染截断 500 行
//     + 「已截断，共 N 行」提示（语义 token text-tertiary）；未超限零变化
//   - groupByPath：同 path 归组净 diff 语义（首条 before → 末条 after）既有锁
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffBlock, groupByPath } from './JournalChangeViews';
import type { JournalEntryView } from '../../ipc/types';

/** 构造完整 JournalEntryView（按 types.d.ts 形状；beforeText/afterText 供 DiffBlock 判空侧） */
function makeEntry(overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: 'j-1',
    workspaceId: 'ws-1',
    taskId: null,
    sessionId: 'ses-1',
    streamSessionId: 'ss-1',
    toolName: 'write_file',
    op: 'create',
    path: 'a.ts',
    beforeHash: null,
    afterHash: 'h-after',
    oldPath: null,
    createdAt: 1,
    beforeText: null,
    afterText: '内容',
    ...overrides,
  };
}

describe('DiffBlock — 渲染行截断（审查 C3）', () => {
  it('rows 超 500 → 只渲染前 500 行 + 「已截断，共 N 行」提示', () => {
    // 600×600 无公共行 → 1200 rows（del 600 + add 600）
    const before = Array.from({ length: 600 }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: 600 }, (_, i) => `new-${i}`).join('\n');
    const { container } = render(<DiffBlock beforeText={before} afterText={after} />);

    const block = container.querySelector('[data-testid="changes-diff"]');
    expect(block).not.toBeNull();
    // 500 行 diff + 1 条截断提示
    expect(block!.childElementCount).toBe(501);

    const hint = screen.getByTestId('changes-diff-truncated');
    expect(hint.textContent).toBe('已截断，共 1200 行');
    expect(hint.className).toContain('text-tertiary');
  });

  it('rows ≤ 500 → 全量渲染，无截断提示', () => {
    const before = Array.from({ length: 100 }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: 100 }, (_, i) => `new-${i}`).join('\n');
    const { container } = render(<DiffBlock beforeText={before} afterText={after} />);

    const block = container.querySelector('[data-testid="changes-diff"]');
    expect(block!.childElementCount).toBe(200);
    expect(screen.queryByTestId('changes-diff-truncated')).toBeNull();
  });

  it('双侧文本皆缺 → 快照缺失提示（既有行为零变化）', () => {
    render(<DiffBlock beforeText={null} afterText={null} />);
    expect(screen.getByText('内容快照缺失，无法展示差异')).toBeInTheDocument();
  });
});

describe('groupByPath — 同 path 归组净 diff（既有锁）', () => {
  it('组内 createdAt 升序，first=最早 before / last=最晚 after', () => {
    const groups = groupByPath([
      makeEntry({ id: 'j-2', path: 'a.ts', createdAt: 200 }),
      makeEntry({ id: 'j-1', path: 'a.ts', createdAt: 100 }),
      makeEntry({ id: 'j-3', path: 'b.ts', createdAt: 50 }),
    ]);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.path === 'a.ts');
    expect(a?.entries.map((e) => e.id)).toEqual(['j-1', 'j-2']);
    expect(a?.first.id).toBe('j-1');
    expect(a?.last.id).toBe('j-2');
  });

  it('空输入 → 空组', () => {
    expect(groupByPath([])).toEqual([]);
  });
});
