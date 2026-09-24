// renderer/src/components/agent/RegisterMcpDialog.test.tsx
//
// P2.4 Task 3：快速创建 MCP 表单测试（spec §4）。
//   - 传输二态 Segmented：本地（stdio）名称/命令/参数(一行一个)/高级(env KeyValueRows+cwd)；
//     远程（HTTP）名称/URL(https)/高级(headers KeyValueRows)；切换清空对方态字段
//   - 同名二段确认：预检命中 → 警示条 + 按钮变「确认覆盖」；改字段重置
//   - 提交 payload：stdio { name, version?, command, args, env, cwd? }；
//     http { name, version?, command:'', transport:'streamable_http', url, headers }
//   - 提交后 mcp.start + onSuccess + onClose；失败红字不关（既有语义）
// P2.5 Task 3：编辑模式（edit prop）——mount 经 resource.getMcpEditView 预填
// 全字段、提交走 resource.updateMcpEntry（name 是引用键不可改）、跳过同名
// 二段确认、加载失败红字；版本 '1.0.0' 缺省不回显（提交仍落 1.0.0），
// 非缺省版本必须原值回传（防 electron 全字段 UPDATE 静默降级回归锁）。
// Mock：window.api 桩（resource.registerMcp / resource.list /
// resource.getMcpEditView / resource.updateMcpEntry / mcp.start）+ workspace store 注入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RegisterMcpDialog } from './RegisterMcpDialog';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { McpEditView, ResourceItem, Workspace } from '../../ipc/types';

const resourceRegisterMcp = vi.fn();
const resourceList = vi.fn();
const resourceGetMcpEditView = vi.fn();
const resourceUpdateMcpEntry = vi.fn();
const mcpStart = vi.fn();

const mockApi = {
  resource: {
    registerMcp: resourceRegisterMcp,
    list: resourceList,
    getMcpEditView: resourceGetMcpEditView,
    updateMcpEntry: resourceUpdateMcpEntry,
  },
  mcp: { start: mcpStart },
};

const REGISTERED_ITEM: ResourceItem = {
  id: 'custom-mcp-my-mcp',
  type: 'mcp',
  source: 'custom',
  slug: 'my-mcp',
  name: 'my-mcp',
  description: '自定义 MCP（npx）',
  installed: true,
  installable: false,
  removable: true,
};

const WS: Workspace = {
  id: 'ws-active',
  name: '当前工作空间',
  description: '',
  directoryPath: '/tmp/ws',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'u',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
};

beforeEach(() => {
  resourceRegisterMcp.mockReset();
  resourceList.mockReset();
  resourceGetMcpEditView.mockReset();
  resourceUpdateMcpEntry.mockReset();
  mcpStart.mockReset();
  resourceRegisterMcp.mockResolvedValue(REGISTERED_ITEM);
  resourceList.mockResolvedValue([]); // 默认无同名
  resourceUpdateMcpEntry.mockResolvedValue(undefined);
  mcpStart.mockResolvedValue(undefined);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  useWorkspaceStore.setState({ workspaces: [WS], activeWorkspaceId: 'ws-active', loading: false, error: null });
});

describe('RegisterMcpDialog — 快速创建 MCP：传输二态', () => {
  it('默认本地态：渲染 名称/版本/命令/参数；无 URL 字段', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    expect(screen.getByLabelText('名称')).toBeInTheDocument();
    expect(screen.getByLabelText('命令')).toBeInTheDocument();
    expect(screen.getByLabelText('参数')).toBeInTheDocument();
    expect(screen.queryByLabelText('URL')).toBeNull();
  });

  it('切到远程态：URL 出现、命令/参数隐藏', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '远程（HTTP）' }));
    expect(screen.getByLabelText('URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('命令')).toBeNull();
    expect(screen.queryByLabelText('参数')).toBeNull();
  });

  it('切换清空对方态字段：本地填命令 → 切远程 → URL 空；切回本地 → 命令空', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('radio', { name: '远程（HTTP）' }));
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('radio', { name: '本地（stdio）' }));
    expect((screen.getByLabelText('命令') as HTMLInputElement).value).toBe('');
  });

  it('远程态 URL 非 https → 提交 disabled + 提示', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '远程（HTTP）' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'http://x.example.com' } });
    expect(screen.getByRole('button', { name: '注册并启动' })).toBeDisabled();
    expect(screen.getByText('URL 必须以 https:// 开头')).toBeInTheDocument();
  });
});

describe('RegisterMcpDialog — env 行编辑（KeyValueRows）', () => {
  it('删除第 1 行 env → 提交 payload env 为空对象', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    // 高级区默认折叠——展开
    fireEvent.click(screen.getByText('高级：环境变量与工作目录'));
    fireEvent.change(screen.getByLabelText('环境变量名 1'), { target: { value: 'FOO' } });
    fireEvent.change(screen.getByLabelText('环境变量值 1'), { target: { value: 'bar' } });
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 行' }));
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(1));
    const [config] = resourceRegisterMcp.mock.calls[0]!;
    expect(config.env).toEqual({});
  });

  it('env 两行 + cwd → payload 透传', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByText('高级：环境变量与工作目录'));
    fireEvent.change(screen.getByLabelText('环境变量名 1'), { target: { value: 'FOO' } });
    fireEvent.change(screen.getByLabelText('环境变量值 1'), { target: { value: 'bar' } });
    fireEvent.click(screen.getByRole('button', { name: '添加环境变量' }));
    fireEvent.change(screen.getByLabelText('环境变量名 2'), { target: { value: 'BAZ' } });
    fireEvent.change(screen.getByLabelText('环境变量值 2'), { target: { value: 'qux' } });
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/opt/wd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalled());
    const [config] = resourceRegisterMcp.mock.calls[0]!;
    expect(config.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(config.cwd).toBe('/opt/wd');
  });
});

describe('RegisterMcpDialog — args 一行一个', () => {
  it('参数 textarea 按行拆分（含带空格的参数值）', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.change(screen.getByLabelText('参数'), { target: { value: '-y\nserver.js\n--port 3000' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalled());
    const [config] = resourceRegisterMcp.mock.calls[0]!;
    expect(config.args).toEqual(['-y', 'server.js', '--port 3000']);
  });
});

describe('RegisterMcpDialog — 远程提交', () => {
  it('远程态提交 payload：transport/url/headers 透传，command 空串', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '远程（HTTP）' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'context7' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://mcp.context7.com/mcp' } });
    fireEvent.click(screen.getByText('高级：请求头'));
    fireEvent.change(screen.getByLabelText('请求头名 1'), { target: { value: 'Authorization' } });
    fireEvent.change(screen.getByLabelText('请求头值 1'), { target: { value: 'Bearer ctx7sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(1));
    const [config] = resourceRegisterMcp.mock.calls[0]!;
    expect(config).toMatchObject({
      name: 'context7',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer ctx7sk-x' },
    });
  });
});

describe('RegisterMcpDialog — 同名二段确认', () => {
  it('预检命中 → 警示条 + 按钮变「确认覆盖」且未提交；再点才提交', async () => {
    resourceList.mockResolvedValue([{ slug: 'dup-mcp' }]);
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup-mcp' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(screen.getByText('将覆盖同名服务器：dup-mcp')).toBeInTheDocument());
    expect(resourceRegisterMcp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认覆盖' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(1));
  });

  it('警示后改字段 → 重置回一段态（警示条消失）', async () => {
    resourceList.mockResolvedValue([{ slug: 'dup-mcp' }]);
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup-mcp' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(screen.getByText('将覆盖同名服务器：dup-mcp')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd2' } });
    expect(screen.queryByText('将覆盖同名服务器：dup-mcp')).toBeNull();
    expect(screen.getByRole('button', { name: '注册并启动' })).toBeInTheDocument();
    // 再触发一次警示后改「参数」字段——同样重置（Task 3 Minor：argsText onChange 缺重置）
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(screen.getByText('将覆盖同名服务器：dup-mcp')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('参数'), { target: { value: '-y' } });
    expect(screen.queryByText('将覆盖同名服务器：dup-mcp')).toBeNull();
    expect(screen.getByRole('button', { name: '注册并启动' })).toBeInTheDocument();
  });

  it('预检 list 失败 → 不阻塞直接提交（主进程覆盖语义兜底）', async () => {
    resourceList.mockRejectedValue(new Error('net down'));
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(1));
  });
});

describe('RegisterMcpDialog — 既有语义回归', () => {
  it('成功 → mcp.start(activeWorkspaceId, name) + onSuccess + onClose', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<RegisterMcpDialog onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'runner' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(mcpStart).toHaveBeenCalledWith('ws-active', 'runner'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('提交失败 → 红字不关弹窗', async () => {
    resourceRegisterMcp.mockRejectedValueOnce(new Error('启动失败'));
    const onClose = vi.fn();
    render(<RegisterMcpDialog onClose={onClose} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(screen.getByText('启动失败')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('版本留空 → payload version undefined', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalled());
    expect(resourceRegisterMcp.mock.calls[0]![0].version).toBeUndefined();
  });
});

// ── P2.5 Task 3：编辑模式（edit prop；spec §3.4/D4）─────────────────────
// mount 拉取 getMcpEditView 预填全字段；提交分流到 updateMcpEntry
// （name 引用键不可改）；无同名二段确认；加载失败红字。
describe('RegisterMcpDialog — 编辑模式（P2.5 Task 3）', () => {
  const STDIO_VIEW: McpEditView = {
    name: 'my-mcp',
    transport: 'stdio',
    version: '1.0.0',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'ghp_x' },
    headers: {},
    cwd: '/opt/wd',
  };

  const HTTP_VIEW: McpEditView = {
    name: 'context7',
    transport: 'streamable_http',
    version: '1.0.0',
    command: '',
    args: [],
    env: {},
    url: 'https://mcp.context7.com/mcp',
    headers: { Authorization: 'Bearer ctx7sk-x' },
  };

  it('edit stdio 条目：mount 拉取视图并全字段预填（命令/参数按行 join/env 行/version 缺省留空/cwd；传输态 stdio）', async () => {
    resourceGetMcpEditView.mockResolvedValue(STDIO_VIEW);
    render(<RegisterMcpDialog edit={{ name: 'my-mcp' }} onClose={() => {}} onSuccess={() => {}} />);
    expect(await screen.findByLabelText('命令')).toBeInTheDocument();
    expect(resourceGetMcpEditView).toHaveBeenCalledWith('my-mcp');
    expect((screen.getByLabelText('命令') as HTMLInputElement).value).toBe('npx');
    expect((screen.getByLabelText('参数') as HTMLTextAreaElement).value).toBe(
      '-y\n@modelcontextprotocol/server-github',
    );
    // version '1.0.0' 是 electron 端缺省值——不回显（提交仍落 1.0.0，闭环不降级）
    expect((screen.getByLabelText('版本') as HTMLInputElement).value).toBe('');
    // 高级区折叠：展开后断言 env 行与 cwd
    fireEvent.click(screen.getByText('高级：环境变量与工作目录'));
    expect((screen.getByLabelText('环境变量名 1') as HTMLInputElement).value).toBe('GITHUB_TOKEN');
    expect((screen.getByLabelText('环境变量值 1') as HTMLInputElement).value).toBe('ghp_x');
    expect((screen.getByLabelText('工作目录') as HTMLInputElement).value).toBe('/opt/wd');
    // 传输态 stdio：URL 字段不出现
    expect(screen.queryByLabelText('URL')).toBeNull();
  });

  it('edit 远程条目：预填 url/headers 行，传输态 http', async () => {
    resourceGetMcpEditView.mockResolvedValue(HTTP_VIEW);
    render(<RegisterMcpDialog edit={{ name: 'context7' }} onClose={() => {}} onSuccess={() => {}} />);
    expect(await screen.findByLabelText('URL')).toBeInTheDocument();
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://mcp.context7.com/mcp');
    fireEvent.click(screen.getByText('高级：请求头'));
    expect((screen.getByLabelText('请求头名 1') as HTMLInputElement).value).toBe('Authorization');
    expect((screen.getByLabelText('请求头值 1') as HTMLInputElement).value).toBe('Bearer ctx7sk-x');
    // 传输态 http：命令/参数字段不出现
    expect(screen.queryByLabelText('命令')).toBeNull();
    expect(screen.queryByLabelText('参数')).toBeNull();
  });

  it('名称 Input disabled（name 是 agent 引用键，编辑不可改）', async () => {
    resourceGetMcpEditView.mockResolvedValue(STDIO_VIEW);
    render(<RegisterMcpDialog edit={{ name: 'my-mcp' }} onClose={() => {}} onSuccess={() => {}} />);
    expect(await screen.findByLabelText('名称')).toBeDisabled();
  });

  it('提交走 updateMcpEntry(name, payload)（非 registerMcp）→ mcp.start + onSuccess + onClose', async () => {
    resourceGetMcpEditView.mockResolvedValue(STDIO_VIEW);
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<RegisterMcpDialog edit={{ name: 'my-mcp' }} onClose={onClose} onSuccess={onSuccess} />);
    expect(await screen.findByLabelText('命令')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(resourceUpdateMcpEntry).toHaveBeenCalledTimes(1));
    const [editName, payload] = resourceUpdateMcpEntry.mock.calls[0]!;
    expect(editName).toBe('my-mcp');
    expect(payload).toEqual({
      version: undefined,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_x' },
      cwd: '/opt/wd',
    });
    expect(resourceRegisterMcp).not.toHaveBeenCalled();
    expect(mcpStart).toHaveBeenCalledWith('ws-active', 'my-mcp');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('edit 模式无同名二段确认：list 预检返回同名也不出现警示条（且不调 list）', async () => {
    resourceList.mockResolvedValue([{ slug: 'my-mcp' }]);
    resourceGetMcpEditView.mockResolvedValue(STDIO_VIEW);
    render(<RegisterMcpDialog edit={{ name: 'my-mcp' }} onClose={() => {}} onSuccess={() => {}} />);
    expect(await screen.findByLabelText('命令')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(resourceUpdateMcpEntry).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/将覆盖同名服务器/)).toBeNull();
    expect(resourceList).not.toHaveBeenCalled();
  });

  it('getMcpEditView reject → 红字「读取 MCP 配置失败：…」', async () => {
    resourceGetMcpEditView.mockRejectedValue(new Error('MCP my-mcp 未注册'));
    render(<RegisterMcpDialog edit={{ name: 'my-mcp' }} onClose={() => {}} onSuccess={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText('读取 MCP 配置失败：MCP my-mcp 未注册')).toBeInTheDocument(),
    );
    expect(resourceUpdateMcpEntry).not.toHaveBeenCalled();
  });

  it('版本防降级回归锁：预填 version 2.1.0 → 提交 updateMcpEntry 收到 version 2.1.0', async () => {
    // electron UPDATE 是全字段替换，version 省略会静默回落 '1.0.0'——
    // 非缺省版本必须回显并原值回传，否则已存 '2.1.0' 的条目被降级
    resourceGetMcpEditView.mockResolvedValue({ ...STDIO_VIEW, version: '2.1.0' });
    render(<RegisterMcpDialog edit={{ name: 'my-mcp' }} onClose={() => {}} onSuccess={() => {}} />);
    expect(await screen.findByLabelText('命令')).toBeInTheDocument();
    expect((screen.getByLabelText('版本') as HTMLInputElement).value).toBe('2.1.0');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(resourceUpdateMcpEntry).toHaveBeenCalledTimes(1));
    expect(resourceUpdateMcpEntry.mock.calls[0]![1].version).toBe('2.1.0');
  });
});
