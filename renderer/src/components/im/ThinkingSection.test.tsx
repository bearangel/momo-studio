// renderer/src/components/im/ThinkingSection.test.tsx
// ThinkingSection 折叠/展开行为：默认折叠（内容不可见）→ 点击展开（可见）→ 再点收起。
// content 为空时整块不渲染。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThinkingSection } from './ThinkingSection';
import { useStreamStore } from '../../stores/stream.store';

describe('ThinkingSection', () => {
  it('默认折叠——不显示 thinking 内容', () => {
    render(<ThinkingSection content="深度思考中..." />);
    // 内容默认折叠
    expect(screen.queryByText('深度思考中...')).not.toBeInTheDocument();
    // toggle 按钮存在
    expect(screen.getByText(/思考过程/)).toBeInTheDocument();
  });

  it('点击展开——显示 thinking 内容', () => {
    render(<ThinkingSection content="深度思考中..." />);
    fireEvent.click(screen.getByText(/思考过程/));
    expect(screen.getByText('深度思考中...')).toBeInTheDocument();
  });

  it('再次点击收起', () => {
    render(<ThinkingSection content="深度思考中..." />);
    const toggle = screen.getByText(/思考过程/);
    fireEvent.click(toggle); // 展开
    fireEvent.click(toggle); // 收起
    expect(screen.queryByText('深度思考中...')).not.toBeInTheDocument();
  });

  it('content 为空时不渲染', () => {
    const { container } = render(<ThinkingSection content="" />);
    expect(container.firstChild).toBeNull();
  });

  it('渲染 markdown 内容', () => {
    render(<ThinkingSection content="**重点**说明" />);
    fireEvent.click(screen.getByText(/思考过程/));
    // 加粗文本「重点」会被渲染为 strong
    expect(screen.getByText('重点')).toBeInTheDocument();
    expect(screen.getByText('说明')).toBeInTheDocument();
  });

  it('isStreaming=true → 标签「思考中…」+ Brain 图标呼吸微光；false 回落「思考过程」', () => {
    // v2.1：isStreaming 不再是占位 prop——流式态标签与图标动画均切换
    const { container, rerender } = render(<ThinkingSection content="思考" isStreaming={true} />);
    expect(screen.getByText('思考中…')).toBeInTheDocument();
    expect(container.querySelector('svg.lucide-brain')?.classList.contains('animate-pulse')).toBe(true);
    // 切到非 streaming：标签回落为「思考过程」，图标动画消失
    rerender(<ThinkingSection content="思考" isStreaming={false} />);
    expect(screen.getByText('思考过程')).toBeInTheDocument();
    expect(container.querySelector('svg.lucide-brain')?.classList.contains('animate-pulse')).toBe(false);
  });
});

// === wire 截断展开（2026-10-14 P0-2）===
// truncated + messageId 置位时展开区提供「展开完整思考」：经 ipc.session.
// getMessageThinking 拉全量 → store.expandThinking 归并（真实 store 验证）。
describe('ThinkingSection：thinking wire 截断展开', () => {
  const getMessageThinkingMock = vi.fn();

  beforeEach(() => {
    getMessageThinkingMock.mockReset();
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      session: { getMessageThinking: getMessageThinkingMock },
    };
    useStreamStore.getState().reset();
  });

  function hydrateTruncated(): void {
    useStreamStore.getState().hydrateFromEvents('m-sec', [
      { id: 'w0', messageId: 'm-sec', seq: 0, eventType: 'thinking_delta', payload: { delta: '预览文本' }, createdAt: 1 },
      { id: 'w1', messageId: 'm-sec', seq: 1, eventType: 'final', payload: { status: 'done' }, createdAt: 2 },
      { id: 'wm', messageId: 'm-sec', seq: 1_000_000_000, eventType: 'thinking_truncated', payload: { fullChars: 5000 }, createdAt: 3 },
    ]);
  }

  it('truncated 置位 → 展开后出现「展开完整思考」；点击拉全量并归并入 store', async () => {
    hydrateTruncated();
    getMessageThinkingMock.mockResolvedValueOnce({ runs: [{ seq: 0, delta: '全'.repeat(5000) }] });
    render(<ThinkingSection content="预览文本" truncated messageId="m-sec" />);
    fireEvent.click(screen.getByText(/思考过程/));
    fireEvent.click(screen.getByText('展开完整思考'));
    await waitFor(() => {
      expect(getMessageThinkingMock).toHaveBeenCalledWith('m-sec');
    });
    await waitFor(() => {
      const s = useStreamStore.getState().streams.get('m-sec');
      expect(s?.thinking).toHaveLength(5000);
      expect(s?.thinkingTruncated).toBeUndefined();
    });
  });

  it('拉取失败 → 显示重试提示，预览保留（不吞错不崩）', async () => {
    hydrateTruncated();
    getMessageThinkingMock.mockRejectedValueOnce(new Error('IPC down'));
    render(<ThinkingSection content="预览文本" truncated messageId="m-sec" />);
    fireEvent.click(screen.getByText(/思考过程/));
    fireEvent.click(screen.getByText('展开完整思考'));
    expect(await screen.findByText('加载失败，点击重试')).toBeInTheDocument();
    expect(useStreamStore.getState().streams.get('m-sec')?.thinking).toBe('预览文本');
  });

  it('未置 truncated（普通历史/实时）→ 无展开按钮，不触发拉取', () => {
    render(<ThinkingSection content="完整思考内容" />);
    fireEvent.click(screen.getByText(/思考过程/));
    expect(screen.queryByText('展开完整思考')).not.toBeInTheDocument();
    expect(getMessageThinkingMock).not.toHaveBeenCalled();
  });
});
