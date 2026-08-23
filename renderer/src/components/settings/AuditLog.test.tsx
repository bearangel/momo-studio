// renderer/src/components/settings/AuditLog.test.tsx
//
// 审计日志面板测试（P2 Task 8）：
//   - 配额卡渲染：上限输入（placeholder 100=继承全局）+ 占用进度条 + 立即清理按钮
//   - 保存上限：数字 → setQuota(ws, n)；清空 → setQuota(ws, null)（回退全局）；
//     非正数 → 报错且不调用 IPC
//   - 立即清理：enforceNow(ws) → 显示删除条数反馈 + 刷新配额
//   - 表格/分页保留：记录照常渲染
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuditLog } from './AuditLog';
import type { ToolCallRecord } from '../../ipc/types';

const RECORDS: ToolCallRecord[] = [
  {
    id: 'r1', workspaceId: 'ws-1', agentBotUserId: '@bot:a', taskId: null,
    toolName: 'read_file', inputSummary: 'in', outputSummary: 'out',
    success: true, durationMs: 12, timestamp: '2026-01-02 10:00:00',
  },
  {
    id: 'r2', workspaceId: 'ws-1', agentBotUserId: '@bot:a', taskId: null,
    toolName: 'bash', inputSummary: 'ls', outputSummary: 'err',
    success: false, durationMs: 30, timestamp: '2026-01-01 10:00:00',
  },
];

const getToolCallsMock = vi.fn();
const getQuotaMock = vi.fn();
const setQuotaMock = vi.fn();
const enforceNowMock = vi.fn();

describe('AuditLog', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      audit: {
        getToolCalls: getToolCallsMock,
        getQuota: getQuotaMock,
        setQuota: setQuotaMock,
        enforceNow: enforceNowMock,
      },
    };
    getToolCallsMock.mockReset().mockResolvedValue([...RECORDS]);
    getQuotaMock.mockReset().mockResolvedValue({ quotaMb: 50, usedBytes: 26_214_400, rowCount: 123 });
    setQuotaMock.mockReset().mockResolvedValue(undefined);
    enforceNowMock.mockReset().mockResolvedValue({ deletedCount: 42 });
  });

  it('渲染配额卡：上限输入（placeholder 100=继承全局）+ 占用文本 + 立即清理按钮', async () => {
    render(<AuditLog workspaceId="ws-1" />);
    expect(await screen.findByPlaceholderText('100=继承全局')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存上限' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即清理' })).toBeInTheDocument();
    // 26,214,400 B = 25.0 MB；配额 50 MB；123 条
    expect(screen.getByText('25.0 MB / 50 MB · 123 条记录')).toBeInTheDocument();
  });

  it('占用进度条宽度按 usedBytes/quotaMb 计算（50%）', async () => {
    const { container } = render(<AuditLog workspaceId="ws-1" />);
    await screen.findByText('25.0 MB / 50 MB · 123 条记录');
    const bar = container.querySelector<HTMLDivElement>('[data-testid="audit-quota-bar"]');
    expect(bar).toBeTruthy();
    expect(bar!.style.width).toBe('50%');
  });

  it('输入数字保存 → setQuota(ws, n)', async () => {
    render(<AuditLog workspaceId="ws-1" />);
    const input = await screen.findByPlaceholderText('100=继承全局');
    fireEvent.change(input, { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: '保存上限' }));
    await waitFor(() => expect(setQuotaMock).toHaveBeenCalledWith('ws-1', 200));
  });

  it('清空输入保存 → setQuota(ws, null) 回退全局', async () => {
    render(<AuditLog workspaceId="ws-1" />);
    const input = await screen.findByPlaceholderText('100=继承全局');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存上限' }));
    await waitFor(() => expect(setQuotaMock).toHaveBeenCalledWith('ws-1', null));
  });

  it('非正数输入 → 报错且不调用 setQuota', async () => {
    render(<AuditLog workspaceId="ws-1" />);
    const input = await screen.findByPlaceholderText('100=继承全局');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存上限' }));
    expect(await screen.findByText('上限必须为正数（MB）')).toBeInTheDocument();
    expect(setQuotaMock).not.toHaveBeenCalled();
  });

  it('立即清理 → enforceNow(ws) + 显示删除条数 + 刷新配额', async () => {
    render(<AuditLog workspaceId="ws-1" />);
    await screen.findByText('25.0 MB / 50 MB · 123 条记录');
    fireEvent.click(screen.getByRole('button', { name: '立即清理' }));
    await waitFor(() => expect(enforceNowMock).toHaveBeenCalledWith('ws-1'));
    expect(await screen.findByText('已清理 42 条')).toBeInTheDocument();
    await waitFor(() => expect(getQuotaMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('表格保留：记录照常渲染（工具名 + 成功/失败徽标）', async () => {
    render(<AuditLog workspaceId="ws-1" />);
    expect(await screen.findByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
  });

  it('加载配额失败 → 显示错误，表格仍可用', async () => {
    getQuotaMock.mockRejectedValue(new Error('quota boom'));
    render(<AuditLog workspaceId="ws-1" />);
    expect(await screen.findByText(/quota boom/)).toBeInTheDocument();
    expect(await screen.findByText('read_file')).toBeInTheDocument();
  });
});
