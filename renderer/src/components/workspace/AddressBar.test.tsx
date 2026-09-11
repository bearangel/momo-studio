// renderer/src/components/workspace/AddressBar.test.tsx
//
// AddressBar 单元测试（v2.7 Task 8，spec §3.5）：
//   - 渲染当前 url；props.url 变化（onBrowserState 推送）同步显示
//   - 回车 → onNavigate(修剪后的值)；非法输入（空 / 非 URL / 非法协议）不触发
//   - onNavigate 拒绝 → 行内错误展示（错误路径）；成功 → 错误清空
//   - Escape → 显示回退到当前 url
// mock 形态照抄 SandboxNotice.test.tsx（globalThis.window.api 桩）——AddressBar
// 本身不触 IPC（onNavigate 由父组件注入），此处无需 api 桩。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddressBar } from './AddressBar';

describe('AddressBar（v2.7 Task 8）', () => {
  it('渲染当前 url（props.url 初始值）', () => {
    render(<AddressBar url="https://example.com/" onNavigate={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('https://example.com/');
  });

  it('props.url 变化（状态推送）→ 显示同步为新 url', () => {
    const { rerender } = render(<AddressBar url="https://a.com/" onNavigate={vi.fn()} />);
    rerender(<AddressBar url="https://b.com/" onNavigate={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('https://b.com/');
  });

  it('回车（合法 https URL）→ onNavigate(修剪后的值)', () => {
    const onNavigate = vi.fn().mockResolvedValue(undefined);
    render(<AddressBar url="" onNavigate={onNavigate} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  https://example.com/  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('https://example.com/');
  });

  it('回车（合法 http / file URL）→ 触发（与主进程 policy.assertUrl 协议白名单对齐）', () => {
    const onNavigate = vi.fn().mockResolvedValue(undefined);
    render(<AddressBar url="" onNavigate={onNavigate} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'http://localhost:5173/' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('非法输入不触发：空串 / 纯空白', () => {
    const onNavigate = vi.fn().mockResolvedValue(undefined);
    render(<AddressBar url="https://keep.com/" onNavigate={onNavigate} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('非法输入不触发：无协议裸域名（主进程 new URL 直接抛非法 URL——客户端不代拼协议）', () => {
    const onNavigate = vi.fn().mockResolvedValue(undefined);
    render(<AddressBar url="" onNavigate={onNavigate} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('非法输入不触发：非白名单协议（javascript: / ftp:）', () => {
    const onNavigate = vi.fn().mockResolvedValue(undefined);
    render(<AddressBar url="" onNavigate={onNavigate} />);
    const input = screen.getByRole('textbox');
    for (const bad of ['javascript:alert(1)', 'ftp://files.example.com/']) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('非 Enter 键不触发导航', () => {
    const onNavigate = vi.fn().mockResolvedValue(undefined);
    render(<AddressBar url="" onNavigate={onNavigate} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'https://example.com/' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('onNavigate 拒绝 → 行内展示错误信息（错误路径）', async () => {
    const onNavigate = vi.fn().mockRejectedValue(new Error('域名被黑名单拦截'));
    render(<AddressBar url="" onNavigate={onNavigate} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'https://blocked.com/' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByText('域名被黑名单拦截')).toBeInTheDocument();
    });
  });

  it('导航成功后再次导航成功 → 旧错误被清空', async () => {
    let rejectNext = true;
    const onNavigate = vi.fn().mockImplementation(() => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error('第一次失败'));
      }
      return Promise.resolve(undefined);
    });
    render(<AddressBar url="" onNavigate={onNavigate} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'https://a.com/' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('第一次失败')).toBeInTheDocument());

    fireEvent.change(input, { target: { value: 'https://b.com/' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.queryByText('第一次失败')).not.toBeInTheDocument();
    });
  });

  it('Escape → 显示回退到当前 url（放弃未提交的输入）', () => {
    render(<AddressBar url="https://current.com/" onNavigate={vi.fn()} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'https://draft.com/' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('https://current.com/');
  });
});
