// renderer/src/components/im/ThinkingSection.test.tsx
// ThinkingSection 折叠/展开行为：默认折叠（内容不可见）→ 点击展开（可见）→ 再点收起。
// content 为空时整块不渲染。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingSection } from './ThinkingSection';

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
