// renderer/src/components/settings/BrowserSettings.test.tsx
//
// 设置页「浏览器」分类测试（v2.7 Task 9，spec §6.2）：
//   - 挂载调 getSettings(workspaceId)，各控件按落库值渲染（信任单选 / 双名单
//     textarea / evaluate 开关 / 侧栏宽度 / 默认折叠）
//   - 信任级别单选 → updateSettings({trust})；evaluate 开关 → {evaluateEnabled}
//     （警示文案在位）；默认折叠 → {sidebarCollapsed}
//   - 名单 textarea 按行拆分（trim / 丢空行）blur 提交 → updateSettings({blacklist|
//     whitelist})；白名单优先语义帮助文案在位（T1 裁定）
//   - 侧栏宽度 blur 提交 → {sidebarWidth}；非法输入不提交且回显原值
//   - updateSettings {ok:false} → 错误行呈现（不静默吞）
//   - 「清除浏览数据」Dialog confirm 防误触：确认 → clearBrowsingData；取消 → 不调
// mock 形态照抄 SandboxNotice.test.tsx（window.api 桩 + ipc Proxy 透传）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserSettings } from './BrowserSettings';
import type { BrowserSettings as BrowserSettingsShape } from '../../ipc/types';

const getSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();
const clearBrowsingDataMock = vi.fn();

const mockApi = {
  browser: {
    getSettings: getSettingsMock,
    updateSettings: updateSettingsMock,
    clearBrowsingData: clearBrowsingDataMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

// 构造完整 BrowserSettings（真实形状——types.d.ts 契约，不用简化占位）
function mkSettings(overrides?: Partial<BrowserSettingsShape>): BrowserSettingsShape {
  return {
    trust: 'ask',
    evaluateEnabled: false,
    blacklist: [],
    whitelist: [],
    sidebarCollapsed: false,
    sidebarWidth: 380,
    ...overrides,
  };
}

beforeEach(() => {
  getSettingsMock.mockReset();
  updateSettingsMock.mockReset();
  clearBrowsingDataMock.mockReset();
  getSettingsMock.mockResolvedValue(mkSettings());
  updateSettingsMock.mockResolvedValue({ ok: true });
  clearBrowsingDataMock.mockResolvedValue(undefined);
});

describe('BrowserSettings（v2.7 Task 9）', () => {
  it('挂载调 getSettings(workspaceId) 并按落库值渲染各控件', async () => {
    getSettingsMock.mockResolvedValue(
      mkSettings({
        trust: 'always',
        evaluateEnabled: true,
        blacklist: ['a.com', 'b.com'],
        whitelist: ['good.com'],
        sidebarCollapsed: true,
        sidebarWidth: 420,
      }),
    );
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledWith('w1'));
    expect(screen.getByRole('heading', { name: '浏览器' })).toBeInTheDocument();
    expect(screen.getByLabelText('永久允许')).toBeChecked();
    expect(screen.getByLabelText('每次询问（默认）')).not.toBeChecked();
    expect(screen.getByLabelText('域名黑名单')).toHaveValue('a.com\nb.com');
    expect(screen.getByLabelText('域名白名单')).toHaveValue('good.com');
    expect(screen.getByLabelText(/允许 browser_evaluate/)).toBeChecked();
    expect(screen.getByLabelText('侧栏默认宽度')).toHaveValue(420);
    expect(screen.getByLabelText('默认折叠')).toBeChecked();
  });

  it('信任级别切「永久允许」→ updateSettings(w1, {trust:always}) 且本地选中态更新', async () => {
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('永久允许'));
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith('w1', { trust: 'always' }),
    );
    expect(screen.getByLabelText('永久允许')).toBeChecked();
  });

  it('信任级别切「拒绝」→ updateSettings(w1, {trust:deny})', async () => {
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('拒绝'));
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith('w1', { trust: 'deny' }));
  });

  it('evaluate 开关：警示文案在位；勾选 → updateSettings(w1, {evaluateEnabled:true})', async () => {
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('开启后 agent 可执行任意页面 JS')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/允许 browser_evaluate/));
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith('w1', { evaluateEnabled: true }),
    );
  });

  it('黑名单 textarea 按行拆分（trim / 丢空行）blur 提交', async () => {
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    const ta = screen.getByLabelText('域名黑名单');
    fireEvent.change(ta, { target: { value: '  Evil.COM:443 \n\nb.com\n  ' } });
    fireEvent.blur(ta);
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith('w1', { blacklist: ['Evil.COM:443', 'b.com'] }),
    );
  });

  it('白名单 textarea blur 提交；白名单优先语义帮助文案在位（T1 裁定）', async () => {
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText('白名单非空时仅白名单放行（黑名单仅当白名单为空时生效）'),
    ).toBeInTheDocument();
    const ta = screen.getByLabelText('域名白名单');
    fireEvent.change(ta, { target: { value: 'good.com' } });
    fireEvent.blur(ta);
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith('w1', { whitelist: ['good.com'] }),
    );
  });

  it('侧栏宽度 blur 提交 → {sidebarWidth:420}；非法输入不提交且回显原值', async () => {
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));

    const input = screen.getByLabelText('侧栏默认宽度');
    fireEvent.change(input, { target: { value: '420' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarWidth: 420 }),
    );

    updateSettingsMock.mockClear();
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(updateSettingsMock).not.toHaveBeenCalled();
    // 回显的是最后一次保存值（420），不是挂载初始值
    await waitFor(() => expect(input).toHaveValue(420));
  });

  it('默认折叠勾选 → updateSettings(w1, {sidebarCollapsed:true})', async () => {
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('默认折叠'));
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarCollapsed: true }),
    );
  });

  it('updateSettings 返回 {ok:false} → 错误行呈现（不静默吞）', async () => {
    updateSettingsMock.mockResolvedValue({ ok: false, error: '非法信任级别: sometimes' });
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('永久允许'));
    await waitFor(() => expect(screen.getByText(/非法信任级别/)).toBeInTheDocument());
    // 保存失败不翻转本地选中态（仍为落库值 ask）
    expect(screen.getByLabelText('每次询问（默认）')).toBeChecked();
  });

  it('「清除浏览数据」：Dialog confirm 防误触——取消不调，确认调 clearBrowsingData(w1)', async () => {
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '清除浏览数据' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/将清除浏览器分区存储的 cookies、缓存与站点数据/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(clearBrowsingDataMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '清除浏览数据' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认' }));
    await waitFor(() => expect(clearBrowsingDataMock).toHaveBeenCalledWith('w1'));
  });

  it('清除失败 → 错误行呈现（不静默吞）', async () => {
    clearBrowsingDataMock.mockRejectedValue(new Error('partition 清理失败'));
    render(<BrowserSettings workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '清除浏览数据' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认' }));
    await waitFor(() => expect(screen.getByText(/partition 清理失败/)).toBeInTheDocument());
  });
});
