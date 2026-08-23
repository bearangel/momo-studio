// renderer/src/components/im/ConflictDialogMount.test.tsx
//
// ConflictDialogMount 测试（I3 修复）：
// 监听 im:conflict IPC 事件，收到时渲染 ConflictDialog。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ConflictDialogMount } from './ConflictDialogMount';

let conflictCallback: ((c: { newTaskId: string; currentTaskId: string; currentRoomId: string }) => void) | null = null;

vi.mock('../../ipc/client', () => ({
  ipc: {
    im: {
      onConflict: (cb: typeof conflictCallback) => {
        conflictCallback = cb;
        return () => {
          conflictCallback = null;
        };
      },
    },
    task: {
      resolveConflict: vi.fn().mockResolvedValue({ action: 'queue' }),
    },
    settings: {
      updateSession: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe('ConflictDialogMount', () => {
  beforeEach(() => {
    conflictCallback = null;
  });

  it('无冲突事件时不渲染弹窗', () => {
    const { container } = render(<ConflictDialogMount />);
    expect(container.firstChild).toBeNull();
  });

  it('收到 im:conflict 事件 → 渲染 ConflictDialog', () => {
    render(<ConflictDialogMount />);

    act(() => {
      conflictCallback?.({
        newTaskId: 'T-002',
        currentTaskId: 'T-001',
        currentRoomId: '!room:home',
      });
    });

    expect(screen.getByText('⚠️ 任务冲突')).toBeTruthy();
    // #T-001 出现在描述 + 多个按钮中，用 getAllByText
    expect(screen.getAllByText(/#T-001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/#T-002/).length).toBeGreaterThan(0);
  });

  it('关闭弹窗后不再渲染', () => {
    render(<ConflictDialogMount />);

    act(() => {
      conflictCallback?.({
        newTaskId: 'T-002',
        currentTaskId: 'T-001',
        currentRoomId: '!room:home',
      });
    });

    expect(screen.getByTestId('conflict-overlay')).toBeTruthy();

    act(() => {
      screen.getByText('关闭').click();
    });

    expect(screen.queryByTestId('conflict-overlay')).toBeNull();
  });
});
