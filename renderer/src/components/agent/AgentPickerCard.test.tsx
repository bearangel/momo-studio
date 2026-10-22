// renderer/src/components/agent/AgentPickerCard.test.tsx
//
// 2026-10-22 Task 13：选择器统一卡片测试（spec 2026-10-22 §6.2/§6.3，预览 B rev2 批准定值）。
// 六条核心断言：①描述两行合同（line-clamp-2 + 整卡 title 全文 + 「暂无说明」占位）
// ②能力徽标计数与 0 计数分类不渲染 ③deniedTools 命中不计入徽标计数（deniedMatch 语义）
// ④点击徽标行展开三区 chip（denied 删除线）再点收起 ⑤勾选态 / Crown 徽标 /
// 主 agent radio 行互斥 ⑥trailing 插槽渲染在名称行行尾。
//
// 组件为纯展示 + 局部状态（无 IPC / store 依赖）——不 mock 任何边界（momo-test-rules #5）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentPickerCard } from './AgentPickerCard';

/** 展开按钮锚点：aria-label = `<name>：能力清单` */
const expandLabel = (name: string): string => `${name}：能力清单`;

describe('AgentPickerCard — 描述两行合同（MembersPanel 已批定值）', () => {
  it('长描述：line-clamp-2 渲染 + 整卡 title 承载全文（悬停可读全量）', () => {
    const long = '负责代码评审与重构建议，覆盖前后端与测试用例，支持按仓库自定义规则集';
    const { container } = render(
      <AgentPickerCard name="评审员" description={long} />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveAttribute('title', long);
    const desc = card.querySelector('p');
    expect(desc).not.toBeNull();
    expect(desc).toHaveClass('line-clamp-2');
    expect(desc).toHaveTextContent(long);
  });

  it('空描述 → 「暂无说明」斜体占位；卡片无 title', () => {
    const { container } = render(<AgentPickerCard name="评审员" description="  " />);
    const placeholder = screen.getByText('暂无说明');
    expect(placeholder).toHaveClass('italic');
    expect(placeholder).toHaveClass('text-tertiary');
    expect(container.firstElementChild).not.toHaveAttribute('title');
  });
});

describe('AgentPickerCard — 能力徽标', () => {
  it('Wrench 2 / Sparkles 3 计数正确；计数 0 分类不渲染（MCP 无徽标）', () => {
    render(
      <AgentPickerCard
        name="编码助手"
        capabilities={{
          tools: ['builtin:read_file', 'builtin:write_file'],
          mcps: [],
          skills: ['skill:a', 'skill:b', 'skill:c'],
          deniedTools: [],
        }}
      />,
    );
    expect(screen.getByTitle('内置工具')).toHaveTextContent(/^2$/);
    expect(screen.getByTitle('技能')).toHaveTextContent(/^3$/);
    // 0 计数分类不渲染（预览 B rev2 定值）
    expect(screen.queryByTitle('MCP 服务器')).not.toBeInTheDocument();
  });

  it('deniedTools 命中（plugin:<id>/* 组模式）的工具不计入徽标计数', () => {
    render(
      <AgentPickerCard
        name="编码助手"
        capabilities={{
          tools: ['plugin:search/web', 'plugin:search/fetch', 'builtin:read'],
          mcps: [],
          skills: [],
          deniedTools: ['plugin:search/*'],
        }}
      />,
    );
    // 2 个 plugin 工具被组模式禁用 → 生效仅 1 个
    expect(screen.getByTitle('内置工具')).toHaveTextContent(/^1$/);
  });

  it('capabilities 未提供（数据未就绪）→ 徽标行不渲染', () => {
    render(<AgentPickerCard name="编码助手" />);
    expect(screen.queryByTitle('内置工具')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: expandLabel('编码助手') })).not.toBeInTheDocument();
  });

  it('capabilityMode="default" → 徽标 title 前缀「默认能力：」（def 级降级语义）', () => {
    render(
      <AgentPickerCard
        name="编码助手"
        capabilityMode="default"
        capabilities={{ tools: ['builtin:read'], mcps: [], skills: [], deniedTools: [] }}
      />,
    );
    expect(screen.getByTitle('默认能力：内置工具')).toBeInTheDocument();
    expect(screen.queryByTitle('内置工具')).not.toBeInTheDocument();
  });
});

describe('AgentPickerCard — 展开三区 chip', () => {
  const caps = {
    tools: ['plugin:search/web', 'builtin:read'],
    mcps: ['mcp:github'],
    skills: ['skill:review'],
    deniedTools: ['plugin:search/*'],
  };

  it('点击徽标行展开三区 chip（工具名/MCP 名/技能名）；denied 命中项带删除线；再点收起', () => {
    render(<AgentPickerCard name="编码助手" capabilities={caps} />);
    fireEvent.click(screen.getByRole('button', { name: expandLabel('编码助手') }));

    // 三区标签 + 原始清单 chip（tools 区含 denied 命中项）
    expect(screen.getByText('内置工具')).toBeInTheDocument();
    expect(screen.getByText('MCP 服务器')).toBeInTheDocument();
    expect(screen.getByText('技能')).toBeInTheDocument();
    expect(screen.getByText('plugin:search/web')).toBeInTheDocument();
    expect(screen.getByText('mcp:github')).toBeInTheDocument();
    expect(screen.getByText('skill:review')).toBeInTheDocument();

    // denied 命中 chip 删除线 + 灰显；未命中正常
    expect(screen.getByText('plugin:search/web')).toHaveClass('line-through');
    expect(screen.getByText('plugin:search/web')).toHaveClass('opacity-50');
    expect(screen.getByText('builtin:read')).not.toHaveClass('line-through');

    // 再点收起
    fireEvent.click(screen.getByRole('button', { name: expandLabel('编码助手') }));
    expect(screen.queryByText('mcp:github')).not.toBeInTheDocument();
  });

  it('空分类区不渲染（与徽标 0 不渲染一致）', () => {
    render(
      <AgentPickerCard
        name="编码助手"
        capabilities={{ tools: ['builtin:read'], mcps: [], skills: [], deniedTools: [] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: expandLabel('编码助手') }));
    expect(screen.getByText('内置工具')).toBeInTheDocument();
    expect(screen.queryByText('MCP 服务器')).not.toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
  });

  it('受控展开（expanded/onToggleExpand）——弹窗手风琴单开依赖；点击只上报不自治翻转', () => {
    const onToggleExpand = vi.fn();
    const { rerender } = render(
      <AgentPickerCard name="编码助手" capabilities={caps} expanded={false} onToggleExpand={onToggleExpand} />,
    );
    fireEvent.click(screen.getByRole('button', { name: expandLabel('编码助手') }));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
    // 受控 false：即便点击也不自行展开
    expect(screen.queryByText('mcp:github')).not.toBeInTheDocument();

    rerender(
      <AgentPickerCard name="编码助手" capabilities={caps} expanded onToggleExpand={onToggleExpand} />,
    );
    expect(screen.getByText('mcp:github')).toBeInTheDocument();
  });
});

describe('AgentPickerCard — 勾选 / Crown 徽标 / 主 agent radio 行', () => {
  it('selected + onToggle：checkbox 勾选态受控，点击触发 onToggle；名称 label 关联可切换', () => {
    const onToggle = vi.fn();
    render(<AgentPickerCard id="inst-1" name="编码助手" selected onToggle={onToggle} />);
    const box = screen.getByLabelText('编码助手') as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
    // 名称 label 与 checkbox 关联（点击名称同样切换）
    fireEvent.click(screen.getByText('编码助手'));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('onSelect（单选模式）：无 checkbox；selected 以 aria-checked + accent 边框表达；点卡选中', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <AgentPickerCard id="inst-1" name="编码助手" selected={false} onSelect={onSelect} />,
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveAttribute('role', 'radio');
    expect(card).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('leader=true → 名称旁 Crown 徽标（leader-badge-<id> 锚点 + 职责 title）；非 leader 无徽标', () => {
    render(
      <>
        <AgentPickerCard id="inst-1" name="编码助手" leader />
        <AgentPickerCard id="inst-2" name="评审员" leader={false} />
      </>,
    );
    const badge = screen.getByTestId('leader-badge-inst-1');
    expect(badge).toHaveAttribute('title', '主 agent：负责接待用户输入与任务分派');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('leader-badge-inst-2')).not.toBeInTheDocument();
  });

  it('showLeaderControl → 卡片底部「主 agent」radio 行（name 同组互斥 + onSetLeader）；未出示时无 radio', () => {
    const onSetA = vi.fn();
    const onSetB = vi.fn();
    const { rerender } = render(
      <>
        <AgentPickerCard id="inst-1" name="编码助手" leader onSetLeader={onSetA} />
        <AgentPickerCard id="inst-2" name="评审员" leader={false} onSetLeader={onSetB} />
      </>,
    );
    // 未出示 leader 控制 → 无 radio 行
    expect(screen.queryByTestId('leader-radio-inst-1')).not.toBeInTheDocument();

    rerender(
      <>
        <AgentPickerCard id="inst-1" name="编码助手" leader showLeaderControl onSetLeader={onSetA} />
        <AgentPickerCard
          id="inst-2"
          name="评审员"
          leader={false}
          showLeaderControl
          onSetLeader={onSetB}
        />
      </>,
    );
    const radioA = screen.getByTestId('leader-radio-inst-1') as HTMLInputElement;
    const radioB = screen.getByTestId('leader-radio-inst-2') as HTMLInputElement;
    // 同组 name（collab-leader，Task 11 锚点）+ 互斥勾选
    expect(radioA.name).toBe('collab-leader');
    expect(radioB.name).toBe('collab-leader');
    expect(radioA.checked).toBe(true);
    expect(radioB.checked).toBe(false);
    expect(screen.getAllByText('主 agent')).toHaveLength(2);
    fireEvent.click(radioB);
    expect(onSetB).toHaveBeenCalledTimes(1);
  });
});

describe('AgentPickerCard — trailing 插槽', () => {
  it('trailing 内容渲染在名称行行尾', () => {
    const { container } = render(
      <AgentPickerCard name="编码助手" trailing={<span className="badge">在线</span>} />,
    );
    const card = container.firstElementChild as HTMLElement;
    const nameRow = card.firstElementChild as HTMLElement;
    expect(nameRow.lastElementChild).not.toBeNull();
    expect(nameRow.lastElementChild).toHaveTextContent('在线');
    expect(screen.getByText('在线')).toBeInTheDocument();
  });
});
