// renderer/src/components/settings/PluginSettings.test.tsx
//
// T7：设置页插件分区——schema→控件映射、sensitive 掩码态、
// overlay 保存语义（空输入不发送 / 清除显式 null）、必填标记、空态。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PluginSettings } from './PluginSettings';
import type { PluginConfigView, ResourceItem } from '../../ipc/types';

const resourceList = vi.fn();
const getConfig = vi.fn();
const setConfig = vi.fn();
vi.mock('../../ipc/client', () => ({
  ipc: {
    resource: { list: (f: unknown) => resourceList(f) },
    plugin: {
      getConfig: (id: string) => getConfig(id),
      setConfig: (id: string, v: unknown) => setConfig(id, v),
    },
  },
}));
vi.mock('../../lib/ipc-error', () => ({
  ipcErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const PLUGINS: ResourceItem[] = [
  {
    id: 'cg',
    type: 'plugin',
    name: 'Codegraph 代码图谱',
    description: '',
    source: 'custom',
    enabled: true,
    plugin: { id: 'cg', state: 'active', devSource: false, sourcePath: null, components: [], enabled: true },
  },
] as unknown as ResourceItem[];

const VIEW: PluginConfigView = {
  scopes: { workspaceRoot: 'workspace', indexCommand: 'global' },
  schema: {
    properties: {
      workspaceRoot: { type: 'string', title: '索引根目录', scope: 'workspace' },
      indexCommand: { type: 'string', title: '索引构建命令' },
      apiToken: { type: 'string', title: 'API Token', sensitive: true },
      watchDebounce: { type: 'number', title: '监听防抖（ms）' },
      enableWatch: { type: 'boolean', title: '启用文件监听' },
      engine: { type: 'string', title: '索引引擎', enum: ['sqlite', 'walk'] },
    },
    required: ['indexCommand'],
  },
  values: { indexCommand: 'codegraph index', watchDebounce: 300, enableWatch: true, engine: 'sqlite' },
  sensitiveConfigured: { apiToken: true },
};

beforeEach(() => {
  resourceList.mockReset().mockResolvedValue(PLUGINS);
  getConfig.mockReset().mockResolvedValue(VIEW);
  setConfig.mockReset().mockResolvedValue(VIEW);
});
afterEach(() => cleanup());

describe('PluginSettings', () => {
  it('插件卡 + 全控件类型映射渲染', async () => {
    render(<PluginSettings />);
    await waitFor(() => expect(screen.getByLabelText(/索引构建命令/)).toBeTruthy());
    expect(screen.getByText('Codegraph 代码图谱')).toBeTruthy();
    // number / boolean / enum 控件存在
    expect((screen.getByLabelText(/监听防抖/) as HTMLInputElement).value).toBe('300');
    expect((screen.getByLabelText(/启用文件监听/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/索引引擎/) as HTMLSelectElement).value).toBe('sqlite');
    // 必填标记（label 文本被 span 分割——取父级 textContent）
    expect(screen.getByText(/索引构建命令/).textContent).toContain('*');
  });

  it('sensitive 字段：密码态 + 已配置占位 + 钥匙串徽标，明文不渲染', async () => {
    render(<PluginSettings />);
    await waitFor(() => expect(screen.getByLabelText('API Token')).toBeTruthy());
    const input = screen.getByLabelText('API Token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.placeholder).toContain('已配置');
    expect(screen.getByText('已存入系统钥匙串')).toBeTruthy();
    expect(screen.queryByDisplayValue(/sk-/)).toBeNull();
  });

  it('保存：非敏感全量 + 敏感仅非空输入（空 = 不变，overlay 语义）', async () => {
    render(<PluginSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(setConfig).toHaveBeenCalled());
    const payload = setConfig.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.indexCommand).toBe('codegraph index');
    expect(payload.watchDebounce).toBe(300);
    expect(payload.enableWatch).toBe(true);
    expect(payload.engine).toBe('sqlite');
    expect(payload.apiToken).toBeUndefined(); // 未输入 → 不发送
  });

  it('清除敏感值 → 显式 null；撤销清除 → 不发送', async () => {
    render(<PluginSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '清除' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(setConfig).toHaveBeenCalled());
    expect((setConfig.mock.calls[0][1] as Record<string, unknown>).apiToken).toBeNull();
    cleanup();
    setConfig.mockClear();

    // 撤销路径：清除 → 撤销 → 保存 → 不发送 apiToken
    render(<PluginSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '清除' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    fireEvent.click(screen.getByRole('button', { name: '撤销清除' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
    expect((setConfig.mock.calls[0][1] as Record<string, unknown>).apiToken).toBeUndefined();
  });

  it('保存失败 → 行内红字；成功 → 成功提示', async () => {
    setConfig.mockRejectedValueOnce(new Error('config 必填项未配置: indexCommand'));
    render(<PluginSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByText(/必填项未配置/)).toBeTruthy());

    setConfig.mockResolvedValueOnce(VIEW);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByText('已保存，配置已生效')).toBeTruthy());
  });

  it('无 config 声明 → 空态卡（此插件未声明配置项）', async () => {
    getConfig.mockResolvedValue(null);
    render(<PluginSettings />);
    await waitFor(() => expect(screen.getByText('此插件未声明配置项')).toBeTruthy());
  });

  it('无插件 → 引导空态', async () => {
    resourceList.mockResolvedValue([]);
    render(<PluginSettings />);
    await waitFor(() => expect(screen.getByText(/前往资源库/)).toBeTruthy());
  });
});

// ── 工作空间维度 v1.1：作用域徽标 + 一次性迁移提示 ──
describe('workspace 作用域徽标与迁移提示（工作空间维度 v1.1）', () => {
  it('scope=workspace 的字段标题旁显示「按工作空间」徽标；global 字段无徽标', async () => {
    render(<PluginSettings />);
    expect(await screen.findByText('索引根目录')).toBeInTheDocument();
    expect(screen.getByText('按工作空间')).toBeInTheDocument();
  });

  it('一次性提示：localStorage 已置位则不再渲染', () => {
    localStorage.setItem('momo.pluginWsConfigHint.v1', '1');
    render(<PluginSettings />);
    expect(screen.queryByText(/按工作空间的配置项独立保存/)).not.toBeInTheDocument();
    localStorage.removeItem('momo.pluginWsConfigHint.v1');
  });
});
