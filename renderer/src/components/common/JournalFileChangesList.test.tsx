// renderer/src/components/common/JournalFileChangesList.test.tsx
//
// 共享文件行渲染件测试（G1）：逐文件行（rename 箭头 + 条数）+ 就地展开 DiffBlock。
// mock 形态照抄 ChangesChip.test（window.api 桩不需要——本组件无 IPC，纯展示）。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { JournalEntryView } from '../../ipc/types';
import { JournalFileChangesList } from './JournalFileChangesList';

function makeEntry(overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: 'je-1', workspaceId: 'ws-1', taskId: null, sessionId: 'ses-1',
    streamSessionId: 's-1', toolName: 'write_file', path: 'src/app.ts', op: 'modify',
    beforeHash: 'hb', afterHash: 'ha', oldPath: null, createdAt: 1757000001000,
    beforeText: 'old-line', afterText: 'new-line', ...overrides,
  };
}

describe('JournalFileChangesList', () => {
  it('渲染逐文件行（路径 + 条数）；点开就地展开 DiffBlock', () => {
    render(<JournalFileChangesList entries={[makeEntry()]} />);
    const row = screen.getByRole('button', { name: /src\/app\.ts/ });
    expect(row).toHaveTextContent(/1 条/);
    fireEvent.click(row);
    expect(screen.getByTestId('changes-diff')).toBeInTheDocument();
  });

  it('rename 条目显示 old → new 箭头路径', () => {
    render(
      <JournalFileChangesList
        entries={[makeEntry({ op: 'rename', oldPath: 'src/old.ts', path: 'src/new.ts' })]}
      />,
    );
    expect(screen.getByRole('button', { name: /src\/old\.ts → src\/new\.ts/ })).toBeInTheDocument();
  });

  it('同 path 多条目合并单行「N 条」（groupByPath 语义）', () => {
    render(
      <JournalFileChangesList
        entries={[
          makeEntry({ id: 'je-1', createdAt: 1757000001000 }),
          makeEntry({ id: 'je-2', createdAt: 1757000002000 }),
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /src\/app\.ts/ })).toHaveTextContent(/2 条/);
  });
});
