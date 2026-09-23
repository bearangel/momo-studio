// renderer/src/components/resource-library/McpConfigDialog.test.tsx
//
// P2.2 Task 7：已装远程 MCP 配置编辑弹窗测试（spec 2026-09-23 §6.2）。
// 打开时 mount 调 resource.getMcpConfig 加载，按 bare 两态渲染：
//   - schema 模式：url Input + 按 schema.properties 渲染字段（values 回显），
//     required 缺填禁提交；提交 { url, config, schema }（headers 键缺省）
//   - 裸模式：url 整条 + headers 动态键值行（可增删）；提交 { url, config: {}, headers }
//
// 关键回归锁（spec §9）：
//   - D9：schema 模式 url 预填 view.url.split('?')[0]——否则 composeRemoteConfig
//     追加同名 query 参数，连接发双份
//   - url 非 https 禁提交（spec §7 前端防线）
//   - 提交锁定期输入与按钮全部禁用 + Esc/遮罩 no-op（照 McpConnectDialog / UploadSkillDialog）
//   - 失败红字留弹窗可重试；成功自关
//
// Mock 方式遵循 ResourceDetail.test.tsx 既有形态：不 vi.mock ipc/client 模块，而是在
// 真实 jsdom window 上装 window.api 属性——ipc.client 是真实 Proxy，getMcpConfig 走
// 真通道（momo-test-rules：mock 收窄到 IPC 边界；onSubmit/onClose 由父注入 vi.fn()）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { McpConfigDialog } from './McpConfigDialog';
import type { McpConfigView } from '../../ipc/types';

// ---- mock IPC 桩（弹窗只触达 resource.getMcpConfig——updateMcpConfig 由 View 层接线）----
const getMcpConfigMock = vi.fn();

const mockApi = {
  resource: {
    getMcpConfig: getMcpConfigMock,
  },
};

// schema 模式 fixture：url 带 query（x-from=query 字段被 composeRemoteConfig 追加过的
// 终态）——D9 断言依据：预填必须剥掉 query
const SCHEMA_VIEW: McpConfigView = {
  name: 'upstash/context7-mcp',
  transport: 'streamable_http',
  bare: false,
  schema: {
    required: ['apiKey'],
    properties: {
      apiKey: { title: 'API Key', description: 'Context7 API 密钥' },
      region: {},
    },
  },
  values: { apiKey: 'sk-old-key', region: 'us' },
  url: 'https://mcp.context7.com/mcp?apiKey=sk-old-key',
  headers: {},
};

// 裸模式 fixture（bare=true：schema 键缺省——IPC 契约 'schema' in result === false）
const BARE_VIEW: McpConfigView = {
  name: 'remote-bare',
  transport: 'streamable_http',
  bare: true,
  values: {},
  url: 'https://mcp.example.com/sse',
  headers: { Authorization: 'Bearer tok-1', 'X-Custom': 'cv' },
};

beforeEach(() => {
  getMcpConfigMock.mockReset();
  getMcpConfigMock.mockResolvedValue(SCHEMA_VIEW);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

// ── 加载与 schema 模式回显 ───────────────────────────────────────────────
describe('McpConfigDialog — 加载', () => {
  it('加载中显示「加载中…」，完成后渲染表单', async () => {
    let resolveLoad: (v: McpConfigView) => void = () => {};
    getMcpConfigMock.mockImplementationOnce(
      () => new Promise<McpConfigView>((resolve) => { resolveLoad = resolve; }),
    );
    render(<McpConfigDialog name="s" serverName="Context7" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('加载中…')).toBeInTheDocument();
    resolveLoad(SCHEMA_VIEW);
    expect(await screen.findByLabelText('服务地址')).toBeInTheDocument();
  });

  it('getMcpConfig 以定义名（name）调用', async () => {
    render(<McpConfigDialog name="upstash/context7-mcp" serverName="s" onSubmit={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(getMcpConfigMock).toHaveBeenCalledWith('upstash/context7-mcp'));
  });

  it('加载失败 → 红字错误留在弹窗、不渲染表单（错误路径）', async () => {
    getMcpConfigMock.mockRejectedValueOnce(new Error('MCP 不存在'));
    render(<McpConfigDialog name="s" serverName="s" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/MCP 不存在/)).toBeInTheDocument();
    expect(screen.queryByLabelText('服务地址')).not.toBeInTheDocument();
  });
});

describe('McpConfigDialog — schema 模式回显（D9）', () => {
  it('字段回显 values；url 预填去 query 的 base url（D9 回归锁）', async () => {
    render(<McpConfigDialog name="s" serverName="Context7" onSubmit={vi.fn()} onClose={vi.fn()} />);
    const apiKey = await screen.findByLabelText('API Key');
    expect(apiKey).toHaveValue('sk-old-key');
    expect(screen.getByLabelText('region')).toHaveValue('us');
    // D9：预填值必须剥掉 query——原样预填会让 composeRemoteConfig 发双份 apiKey
    expect(screen.getByLabelText('服务地址')).toHaveValue('https://mcp.context7.com/mcp');
  });

  it('required 缺填 → 「保存」禁用；补齐恢复', async () => {
    render(<McpConfigDialog name="s" serverName="s" onSubmit={vi.fn()} onClose={vi.fn()} />);
    await screen.findByLabelText('API Key');
    // 编辑场景：值已预填（'sk-old-key'）→ 保存可用；清空 apiKey → required 缺填禁用
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-new' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('url 非 https → 禁提交（前端防线，spec §7）', async () => {
    render(<McpConfigDialog name="s" serverName="s" onSubmit={vi.fn()} onClose={vi.fn()} />);
    await screen.findByLabelText('服务地址');
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://mcp.example.com/mcp' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://mcp.example.com/mcp' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });
});

describe('McpConfigDialog — schema 模式提交', () => {
  it('提交 { url(去 query), config, schema 透传 }；headers 键缺省（仅裸模式契约）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConfigDialog name="s" serverName="s" onSubmit={onSubmit} onClose={vi.fn()} />);
    await screen.findByLabelText('API Key');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const input = onSubmit.mock.calls[0][0];
    expect(input.url).toBe('https://mcp.context7.com/mcp');
    expect(input.config).toEqual({ apiKey: 'sk-old-key', region: 'us' });
    expect(input.schema).toEqual(SCHEMA_VIEW.schema);
    expect('headers' in input).toBe(false);
  });

  it('清空可选项 → 不随 config 下发（空串剔除，同安装语义）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConfigDialog name="s" serverName="s" onSubmit={onSubmit} onClose={vi.fn()} />);
    await screen.findByLabelText('region');
    fireEvent.change(screen.getByLabelText('region'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ config: { apiKey: 'sk-old-key' } }),
      ),
    );
  });

  it('编辑 url 后提交携带新 url', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConfigDialog name="s" serverName="s" onSubmit={onSubmit} onClose={vi.fn()} />);
    await screen.findByLabelText('服务地址');
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://mcp2.example.com/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://mcp2.example.com/mcp' })),
    );
  });
});

// ── 裸模式 ───────────────────────────────────────────────────────────────
describe('McpConfigDialog — 裸模式', () => {
  beforeEach(() => {
    getMcpConfigMock.mockReset();
    getMcpConfigMock.mockResolvedValue(BARE_VIEW);
  });

  it('url 整条回显 + headers 键值行预填', async () => {
    render(<McpConfigDialog name="s" serverName="s" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByLabelText('服务地址')).toHaveValue('https://mcp.example.com/sse');
    const keys = screen.getAllByLabelText('Header 名');
    const vals = screen.getAllByLabelText('Header 值');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toHaveValue('Authorization');
    expect(keys[1]).toHaveValue('X-Custom');
    expect(vals[0]).toHaveValue('Bearer tok-1');
    expect(vals[1]).toHaveValue('cv');
  });

  it('headers 行可增删：「添加 Header」出新空行；行删除按钮移除该行', async () => {
    render(<McpConfigDialog name="s" serverName="s" onSubmit={vi.fn()} onClose={vi.fn()} />);
    await screen.findByLabelText('服务地址');
    // 增行（新行在末尾，键值均空）
    fireEvent.click(screen.getByRole('button', { name: '添加 Header' }));
    expect(screen.getAllByLabelText('Header 名')).toHaveLength(3);
    expect(screen.getAllByLabelText('Header 名')[2]!).toHaveValue('');
    // 删第二行（X-Custom）
    fireEvent.click(screen.getAllByRole('button', { name: '删除 Header' })[1]!);
    const keyValues = screen
      .getAllByLabelText('Header 名')
      .map((i) => (i as HTMLInputElement).value);
    expect(keyValues).toEqual(['Authorization', '']);
  });

  it('提交 { url, config: {}, headers }——空键行剔除（整包覆盖语义）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConfigDialog name="s" serverName="s" onSubmit={onSubmit} onClose={vi.fn()} />);
    await screen.findByLabelText('服务地址');
    // 加一行：键留空、值填占位——空键行不得随 headers 下发
    fireEvent.click(screen.getByRole('button', { name: '添加 Header' }));
    const newKey = screen.getAllByLabelText('Header 名')[2]!;
    const newVal = screen.getAllByLabelText('Header 值')[2]!;
    fireEvent.change(newKey, { target: { value: '' } });
    fireEvent.change(newVal, { target: { value: 'should-drop' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const input = onSubmit.mock.calls[0][0];
    expect(input.url).toBe('https://mcp.example.com/sse');
    expect(input.config).toEqual({});
    expect(input.headers).toEqual({ Authorization: 'Bearer tok-1', 'X-Custom': 'cv' });
  });

  it('删光全部 headers 行 → 提交 headers: {}（整包覆盖 = 可清空）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConfigDialog name="s" serverName="s" onSubmit={onSubmit} onClose={vi.fn()} />);
    await screen.findByLabelText('服务地址');
    // 删一个、re-query、再删下一个——for...of 快照点击易踩到已卸载的旧按钮
    while (screen.queryAllByRole('button', { name: '删除 Header' }).length > 0) {
      fireEvent.click(screen.getAllByRole('button', { name: '删除 Header' })[0]!);
    }
    expect(screen.queryByLabelText('Header 名')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ headers: {} })),
    );
  });
});

// ── 提交闭环与锁定 ───────────────────────────────────────────────────────
describe('McpConfigDialog — 提交闭环 / 锁定', () => {
  it('成功 → 弹窗自关（onClose）', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConfigDialog name="s" serverName="s" onSubmit={onSubmit} onClose={onClose} />);
    await screen.findByLabelText('API Key');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('失败 → 红字错误留在弹窗、不 onClose、解锁后可重试', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('保存失败：网络超时'));
    render(<McpConfigDialog name="s" serverName="s" onSubmit={onSubmit} onClose={onClose} />);
    await screen.findByLabelText('API Key');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/网络超时/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    onSubmit.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('提交锁定期 → 输入与按钮全部禁用（防双击 + Esc/遮罩 no-op）', async () => {
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn().mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSubmit = resolve; }),
    );
    render(<McpConfigDialog name="s" serverName="s" onSubmit={onSubmit} onClose={vi.fn()} />);
    await screen.findByLabelText('API Key');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    });
    expect(screen.getByLabelText('服务地址')).toBeDisabled();
    expect(screen.getByLabelText('API Key')).toBeDisabled();
    resolveSubmit();
  });
});
