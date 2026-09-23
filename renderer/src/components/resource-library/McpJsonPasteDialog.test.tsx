// renderer/src/components/resource-library/McpJsonPasteDialog.test.tsx
//
// MCP JSON 批量导入弹窗测试（spec §4.2）：
//   - 粘贴 → 解析预览（含同名覆盖确认）→ 逐条注册 → 结果摘要
//
// 行为约定：
//   - 非法 JSON 解析错误内联展示，不触发注册
//   - 解析成功展示待导入清单（名称 + 命令摘要）
//   - 同名服务器出现覆盖确认文案；确认后逐条注册并展示结果摘要
//   - 部分失败展示失败清单（名称+原因），成功项不回滚
//
// Mock 策略：window.api 桩（resource.list / resource.registerMcp）。
// 遵循既有 ResourceLibraryView / RegisterMcpDialog 形态——不 vi.mock 模块，
// 在真实 jsdom window 上装 window.api 属性，ipc.client 走真通道（Proxy）经桩。
// vitest globals:false，显式导入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { McpJsonPasteDialog } from './McpJsonPasteDialog';
import type { ResourceItem } from '../../ipc/types';

// ---- mock IPC 桩（弹窗只触达 resource 两个通道）----
const resourceList = vi.fn();
const resourceRegisterMcp = vi.fn();

const mockApi = {
  resource: { list: resourceList, registerMcp: resourceRegisterMcp },
};

// ---- 测试载荷 ----
const NEW_JSON = JSON.stringify({ mcpServers: { fresh: { command: 'npx', args: ['-y', 'a'] } } });
const OVERLAP_JSON = JSON.stringify({ mcpServers: { github: { command: 'npx' } } });

// 同名冲突预检用 installed item（slug = 'github'）
const INSTALLED_GITHUB: ResourceItem = {
  id: 'custom-mcp-github',
  type: 'mcp',
  source: 'custom',
  slug: 'github',
  name: 'github',
  description: '',
  installed: true,
  installable: false,
  removable: true,
};

// registerMcp 成功时返回的占位 ResourceItem（主进程 custom 映射产出）
const REGISTERED_FRESH: ResourceItem = {
  id: 'custom-mcp-fresh',
  type: 'mcp',
  source: 'custom',
  slug: 'fresh',
  name: 'fresh',
  description: '',
  installed: true,
  installable: false,
  removable: true,
};

beforeEach(() => {
  resourceList.mockReset().mockResolvedValue([] as ResourceItem[]);
  resourceRegisterMcp.mockReset().mockResolvedValue(REGISTERED_FRESH);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('McpJsonPasteDialog', () => {
  it('非法 JSON 解析错误内联展示且不触发注册', async () => {
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), { target: { value: 'not json' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText('内容不是合法 JSON')).toBeTruthy();
    expect(resourceRegisterMcp).not.toHaveBeenCalled();
  });

  it('解析成功展示待导入清单（名称+命令摘要）', async () => {
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), { target: { value: NEW_JSON } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText('fresh')).toBeTruthy();
    // 命令摘要：命令 + 参数拼合
    expect(screen.getByText('npx -y a')).toBeTruthy();
    // 「待导入 1 条」
    expect(screen.getByText('待导入 1 条：')).toBeTruthy();
  });

  it('同名服务器出现覆盖确认文案；确认后逐条注册并展示结果摘要', async () => {
    // 已存在 github mcp → 解析后的 github 应被识别为冲突
    resourceList.mockResolvedValueOnce([INSTALLED_GITHUB]);
    const onSuccess = vi.fn();
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), { target: { value: OVERLAP_JSON } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText(/将覆盖 1 个同名服务器/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() =>
      expect(resourceRegisterMcp).toHaveBeenCalledWith({ name: 'github', command: 'npx' }),
    );
    expect(await screen.findByText(/成功 1 条/)).toBeTruthy();
    // 部分成功（1 ok / 0 fail）也触发 onSuccess 刷新父列表
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('部分失败展示失败清单（名称+原因），成功项不回滚', async () => {
    // 第一条 a 失败，第二条 b 成功
    resourceRegisterMcp
      .mockRejectedValueOnce(new Error('启动失败'))
      .mockResolvedValueOnce(REGISTERED_FRESH);
    const onSuccess = vi.fn();
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), {
      target: { value: JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }) },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    expect(await screen.findByText(/失败 1 条/)).toBeTruthy();
    expect(screen.getByText('a：启动失败')).toBeTruthy();
    // 成功项不回滚：b 已被调用
    expect(resourceRegisterMcp).toHaveBeenCalledTimes(2);
    expect(resourceRegisterMcp).toHaveBeenNthCalledWith(1, { name: 'a', command: 'x' });
    expect(resourceRegisterMcp).toHaveBeenNthCalledWith(2, { name: 'b', command: 'y' });
    // 1 成功 → onSuccess 触发
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('远程条目展示「远程」徽标与 url，本地条目展示「本地」徽标（P2 转正）', async () => {
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            weather: { url: 'https://mcp.example.com/sse' },
            fs: { command: 'npx' },
          },
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText('远程')).toBeTruthy();
    expect(screen.getByText('本地')).toBeTruthy();
    // 远程行展示端点 url（command 为空串无可展示）
    expect(screen.getByText('https://mcp.example.com/sse')).toBeTruthy();
  });

  it('远程条目导入时 registerMcp 收到 transport + url（二态转发）', async () => {
    const onSuccess = vi.fn();
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            weather: { url: 'https://mcp.example.com/sse' },
            fs: { command: 'npx' },
          },
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(2));
    expect(resourceRegisterMcp).toHaveBeenNthCalledWith(1, {
      name: 'weather',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.example.com/sse',
    });
    // 本地条目不带 transport/url（缺省 stdio）
    expect(resourceRegisterMcp).toHaveBeenNthCalledWith(2, { name: 'fs', command: 'npx' });
    expect(await screen.findByText(/成功 2 条/)).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
