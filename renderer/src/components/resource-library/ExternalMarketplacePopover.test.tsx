// renderer/src/components/resource-library/ExternalMarketplacePopover.test.tsx
// ExternalMarketplacePopover 行为（P2.3 spec §4/§7）：
//   ① 三类型清单渲染（MCP 5 卡 / Skill 2 卡 / Agent 预告卡）
//   ② 点「打开」→ window.api.misc.openExternal(url)，面板保持开（可连开多个）
//   ③ 预告卡（无 url）无「打开」、无 button 角色、点击无副作用
//   ④ 面板底部两行常驻提示文案在（spec §4 原文）
//   ⑤ openExternal reject → 面板内红字（role=alert + text-status-error）且可重试
//   ⑥ Esc / 点击外部（document mousedown）关闭
// Mock 方式遵循 ResourceDetail.test.tsx 既有形态：真实 jsdom window 上装
// window.api 属性——组件直连 window.api.misc，只装 misc 命名空间
//（momo-test-rules：mock 收窄到 IPC 边界，业务逻辑用真实实现）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExternalMarketplacePopover } from './ExternalMarketplacePopover';
import type { ResourceType } from '../../ipc/types';

// window.api 属性安装（只装组件触达的 misc 命名空间）
const openExternalMock = vi.fn<[], Promise<void>>();

const mockApi = {
  misc: {
    openExternal: openExternalMock,
  },
};

/** 渲染并点开面板（三类型共用入口动作） */
const openPanel = (type: ResourceType): void => {
  render(<ExternalMarketplacePopover type={type} />);
  fireEvent.click(screen.getByRole('button', { name: '外部市场' }));
};

beforeEach(() => {
  openExternalMock.mockReset();
  // 默认放行（happy path 基线）；失败路径在用例内 mockRejectedValueOnce 覆盖
  openExternalMock.mockResolvedValue(undefined);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('ExternalMarketplacePopover - ① 三类型清单渲染', () => {
  it('MCP 页：标题「MCP 市场」+ 5 张市场卡（各带「打开」入口）', () => {
    openPanel('mcp');
    expect(screen.getByText('MCP 市场')).toBeTruthy();
    for (const name of ['Smithery', 'mcp.so', 'Glama', 'PulseMCP', 'MCP 官方目录']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /打开/ })).toHaveLength(5);
  });

  it('Skill 页：标题「Skill 市场」+ 2 张市场卡（skills.sh / ClawHub）', () => {
    openPanel('skill');
    expect(screen.getByText('Skill 市场')).toBeTruthy();
    expect(screen.getByText('skills.sh')).toBeTruthy();
    expect(screen.getByText('ClawHub')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /打开/ })).toHaveLength(2);
  });

  it('Agent 页：标题「Agent 市场」+ momo hub 预告卡（描述标注「即将上线」）', () => {
    openPanel('agent');
    expect(screen.getByText('Agent 市场')).toBeTruthy();
    expect(screen.getByText('momo hub')).toBeTruthy();
    expect(screen.getByText('官方统一市场 · 即将上线')).toBeTruthy();
  });
});

describe('ExternalMarketplacePopover - ② 打开动作', () => {
  it('点「打开」→ openExternal(url) 原样透传，面板保持开（连开多个）', () => {
    openPanel('mcp');
    fireEvent.click(screen.getByRole('button', { name: /Smithery/ }));
    expect(openExternalMock).toHaveBeenCalledWith('https://smithery.ai');
    // 面板不关（spec §4：可连开多个）——aria-expanded 仍为 true、内容仍在文档
    expect(screen.getByRole('button', { name: '外部市场' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('MCP 市场')).toBeTruthy();
    // 第二张卡继续打开：第二次调用、参数为各自 url
    fireEvent.click(screen.getByRole('button', { name: /Glama/ }));
    expect(openExternalMock).toHaveBeenCalledTimes(2);
    expect(openExternalMock).toHaveBeenLastCalledWith('https://glama.ai/mcp/servers');
  });
});

describe('ExternalMarketplacePopover - ③ 预告卡不可点', () => {
  it('无 url：无「打开」按钮、卡片非 button 角色、点击无 openExternal 副作用', () => {
    openPanel('agent');
    expect(screen.queryByRole('button', { name: /打开/ })).toBeNull();
    // 卡片本身不是 button（spec §7：非禁用态欺骗，直接不可点样式）
    expect(screen.getByText('momo hub').closest('button')).toBeNull();
    fireEvent.click(screen.getByText('momo hub'));
    expect(openExternalMock).not.toHaveBeenCalled();
  });
});

describe('ExternalMarketplacePopover - ④ 底部两行常驻提示', () => {
  it('spec §4 原文两行小字在面板内', () => {
    openPanel('skill');
    expect(screen.getByText('在浏览器打开 · 应用内不安装')).toBeTruthy();
    expect(
      screen.getByText(
        '回来怎么装：MCP 用＋菜单「粘贴 MCP JSON / 导入 .dxt .mcpb」；Skill 用＋菜单上传 zip；Agent 用＋菜单新建或导入',
      ),
    ).toBeTruthy();
  });
});

describe('ExternalMarketplacePopover - ⑤ 打开失败红字可重试', () => {
  it('reject → 面板内红字（role=alert + text-status-error）不关面板；重试成功红字消失', async () => {
    openPanel('mcp');
    openExternalMock.mockRejectedValueOnce(new Error('被系统拦截'));
    fireEvent.click(screen.getByRole('button', { name: /Smithery/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('打开失败');
    expect(alert.textContent).toContain('被系统拦截');
    // 红字 = 语义状态色 token（spec §7「面板红字」）
    expect(alert.className).toContain('text-status-error');
    // 面板未关
    expect(screen.getByText('MCP 市场')).toBeTruthy();
    // 可重试：再次点击（mock 已恢复 resolved）→ 调用计数 +1、红字消失
    fireEvent.click(screen.getByRole('button', { name: /Smithery/ }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(openExternalMock).toHaveBeenCalledTimes(2);
  });
});

describe('ExternalMarketplacePopover - ⑥ 关闭行为', () => {
  it('Esc 关闭面板', () => {
    openPanel('mcp');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('MCP 市场')).toBeNull();
  });

  it('点击面板外部关闭（document mousedown，照 AddMenu 手法）', () => {
    openPanel('mcp');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('MCP 市场')).toBeNull();
  });
});
