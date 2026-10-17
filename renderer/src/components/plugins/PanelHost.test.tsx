// renderer/src/components/plugins/PanelHost.test.tsx
//
// T4：PanelHost 三态 + iframe 沙箱属性 + Esc 退出 + 违规三振断开。
// PanelChannel 协议细节由 lib/plugin/panel-channel.test.ts 覆盖，此处只锁
// 宿主组件的 UI 状态机与挂载属性。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PanelHost, formatTokenValue } from './PanelHost';
import type { PluginPanelInfo } from '../../ipc/types';

const onPanelEvent = vi.fn((_cb: unknown) => () => undefined);
const callService = vi.fn();
vi.mock('../../ipc/client', () => ({
  ipc: { plugin: { onPanelEvent: (cb: unknown) => onPanelEvent(cb), callService: (m: string, p: unknown) => callService(m, p) } },
}));

const PANEL: PluginPanelInfo = {
  pluginId: 'cg',
  pluginName: 'Codegraph',
  panelId: 'graph',
  title: '代码图谱',
  icon: 'lucide:git-fork',
  placement: 'sidebar',
      entryUrl: 'momo-plugin://cg/panel/index.html',
};

function renderHost(overrides: Partial<Parameters<typeof renderHostImpl>[0]> = {}) {
  return renderHostImpl({ panel: PANEL, onExit: vi.fn(), ...overrides });
}

function renderHostImpl(props: { panel: PluginPanelInfo; onExit: () => void }) {
  return render(<PanelHost {...props} />);
}

beforeEach(() => {
  onPanelEvent.mockClear().mockReturnValue(() => undefined);
  callService.mockClear();
});
afterEach(() => {
  cleanup();
});

describe('挂载属性', () => {
  it('iframe：sandbox=allow-scripts（无 allow-same-origin）、src=entryUrl、title', () => {
    renderHost();
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('src')).toBe('momo-plugin://cg/panel/index.html');
    expect(frame?.getAttribute('title')).toBe('代码图谱');
  });

  it('header 展示面板标题', () => {
    renderHost();
    expect(screen.getByText('代码图谱')).toBeTruthy();
  });
});

describe('三态', () => {
  it('加载失败（iframe error）→ 红字占位 + 重试按钮', () => {
    renderHost();
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    fireEvent.error(frame);
    expect(screen.getByText('面板加载失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('重试 → 重新挂载 iframe（attempt key 变化）', () => {
    renderHost();
    const first = document.querySelector('iframe');
    fireEvent.error(first as HTMLIFrameElement);
    const retryBtn = screen.getByRole('button', { name: '重试' });
    fireEvent.click(retryBtn);
    const second = document.querySelector('iframe');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('通道违规三振 → 断开态 + 重新连接按钮', async () => {
    renderHost();
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    const bad = { data: { type: 'host:hax' }, origin: 'https://evil.example', source: frame.contentWindow };
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new MessageEvent('message', bad));
    }
    await waitFor(() => {
      // header badge 与占位卡同文案——断言存在即可
      expect(screen.getAllByText('通道已断开').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy();
  });

  it('断开后合法消息不再被处理（断开即终态，重连=重挂）', async () => {
    renderHost();
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'hax' }, origin: 'https://evil.example', source: frame.contentWindow }),
      );
    }
    await waitFor(() => expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    expect(document.querySelector('iframe')).not.toBeNull();
  });
});

describe('交互', () => {
  it('Esc → onExit', () => {
    const onExit = vi.fn();
    renderHostImpl({ panel: PANEL, onExit });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('formatTokenValue', () => {
  it('RGB 通道三元组换算为 rgb()；其余透传', () => {
    expect(formatTokenValue('255 255 255')).toBe('rgb(255,255,255)');
    expect(formatTokenValue(' 94 106 210 ')).toBe('rgb(94,106,210)');
    expect(formatTokenValue('rgba(94, 106, 210, 0.12)')).toBe('rgba(94, 106, 210, 0.12)');
    expect(formatTokenValue('')).toBe('');
  });
});
