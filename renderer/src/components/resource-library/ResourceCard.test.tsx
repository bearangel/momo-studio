// renderer/src/components/resource-library/ResourceCard.test.tsx
// ResourceCard 行为（2026-10-23 卡片化，条件渲染 1:1 迁移自 ResourceRow，零行为变更）：
//   - 渲染名称/描述 + 选中态 accent 边框；P1 预览批准定值锁（卡片解剖 / 两行截断）
//   - 状态矩阵 13 形态契约锁（P1 预览 §D：安装/启用/已启用/已安装/已禁用/删除/
//     编辑/配置/插件三态/插件停用源徽标）——custom agent →「编辑」（模型配置走
//     DefinitionEditor）、marketplace 已装 agent →「配置」，二者互斥分断言
//   - 2D 键盘导航：列数按 offsetTop 分组动态推导。jsdom 无布局引擎，用
//     Object.defineProperty 模拟真实网格行分组（浏览器运行时同值 offsetTop 分行
//     同语义）——仿真布局而非简化组件（momo-test-rules 铁律 1）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceCard } from './ResourceCard';
import type { ResourceItem } from '../../ipc/types';

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'custom-mcp-x', type: 'mcp', source: 'custom', slug: 'x', name: '服务器X',
    description: '一行描述', installed: true, installable: false, removable: true, ...over,
  };
}

const noop = (): void => undefined;

describe('ResourceCard 基础', () => {
  it('渲染名称/描述，点卡触发 onSelect', () => {
    const onSelect = vi.fn();
    render(<ResourceCard item={mkItem({})} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('服务器X'));
    expect(onSelect).toHaveBeenCalledWith('custom-mcp-x');
  });

  it('选中态有 accent 边框类', () => {
    const { container } = render(<ResourceCard item={mkItem({})} selected={true} onSelect={noop} />);
    expect(container.firstChild).toHaveClass('border-accent-500');
  });

  it('P1 预览批准定值：卡片解剖（flex-col gap-2 p-3 rounded-lg bg-surface-2 min-w-0）', () => {
    const { container } = render(<ResourceCard item={mkItem({})} selected={false} onSelect={noop} />);
    expect(container.firstChild).toHaveClass(
      'flex', 'flex-col', 'gap-2', 'p-3', 'rounded-lg', 'bg-surface-2', 'min-w-0', 'border',
    );
  });

  it('P1 预览批准定值：描述两行截断（line-clamp-2 + min-h-9，同行卡片底栏对齐）', () => {
    render(<ResourceCard item={mkItem({})} selected={false} onSelect={noop} />);
    expect(screen.getByText('一行描述')).toHaveClass('text-xs', 'text-tertiary', 'leading-normal', 'line-clamp-2', 'min-h-9');
  });
});

describe('ResourceCard 状态矩阵（P1 预览 §D 契约锁，13 形态）', () => {
  it('① agent·builtin 未启用：仅「启用」钮（无配置/停用/已启用标记）', () => {
    render(
      <ResourceCard
        item={mkItem({
          id: 'builtin-agent-a', type: 'agent', source: 'builtin', slug: 'a',
          installed: true, installable: false, removable: false, builtin: { agentEnabled: false },
        })}
        selected={false} onSelect={noop} onEnable={noop} onConfigure={noop} onDisable={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '启用' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '配置' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停用' })).toBeNull();
    expect(screen.queryByText('已启用')).toBeNull();
  });

  it('② agent·builtin 已启用：✓已启用标记 + 配置 + 停用', () => {
    render(
      <ResourceCard
        item={mkItem({
          id: 'builtin-agent-a', type: 'agent', source: 'builtin', slug: 'a',
          installed: true, installable: false, removable: false, builtin: { agentEnabled: true },
        })}
        selected={false} onSelect={noop} onEnable={noop} onConfigure={noop} onDisable={noop}
      />,
    );
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByRole('button', { name: '配置' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '停用' })).toBeTruthy();
  });

  it('③ agent·custom 已装：编辑钮 + 删除图标钮（aria-label 带资源名）', () => {
    render(
      <ResourceCard
        item={mkItem({ id: 'custom-agent-w', type: 'agent', source: 'custom', slug: 'w', name: '技术文档写手' })}
        selected={false} onSelect={noop} onEdit={noop} onDelete={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除 技术文档写手' })).toBeTruthy();
  });

  it('④ agent·marketplace 可安装：安装钮，点击不冒泡到卡 onSelect', () => {
    const onInstall = vi.fn();
    const onSelect = vi.fn();
    render(
      <ResourceCard
        item={mkItem({
          id: 'marketplace-agent-p', type: 'agent', source: 'marketplace', slug: 'p',
          installed: false, installable: true, removable: false,
        })}
        selected={false} onSelect={onSelect} onInstall={onInstall}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith('marketplace-agent-p');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('⑤ agent·marketplace 已装：配置钮（编辑不出现——custom 专属）', () => {
    render(
      <ResourceCard
        item={mkItem({
          id: 'marketplace-agent-k', type: 'agent', source: 'marketplace', slug: 'k',
          installed: true, installable: false, removable: true,
        })}
        selected={false} onSelect={noop} onEdit={noop} onConfigure={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '配置' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });

  it('⑥ mcp·builtin：✓已安装标记，无删除钮（随应用分发不可删）', () => {
    render(
      <ResourceCard
        item={mkItem({
          id: 'builtin-mcp-fs', type: 'mcp', source: 'builtin', slug: 'fs',
          installed: true, installable: false, removable: false,
        })}
        selected={false} onSelect={noop}
      />,
    );
    expect(screen.getByText('已安装')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });

  it('⑦ mcp·custom 停用态：warning「已停用」替代 ✓已安装（组⑤；D5 措辞统一）', () => {
    render(
      <ResourceCard
        item={mkItem({ id: 'custom-mcp-wiki', slug: 'wiki', mcp: { enabled: false } })}
        selected={false} onSelect={noop}
      />,
    );
    expect(screen.getByText('已停用')).toBeTruthy();
    expect(screen.queryByText('已禁用')).toBeNull();
    expect(screen.queryByText('已安装')).toBeNull();
  });

  it('⑧ mcp·smithery 可安装：安装钮 + Smithery 徽标', () => {
    render(
      <ResourceCard
        item={mkItem({
          id: 'smithery-mcp-c7', source: 'smithery', slug: 'context7',
          installed: false, installable: true, removable: false,
        })}
        selected={false} onSelect={noop} onInstall={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy();
    expect(screen.getByText('Smithery')).toBeTruthy();
  });

  it('⑨ skill·builtin：✓已安装标记', () => {
    render(
      <ResourceCard
        item={mkItem({
          id: 'builtin-skill-fe', type: 'skill', source: 'builtin', slug: 'fe',
          installed: true, installable: false, removable: false,
        })}
        selected={false} onSelect={noop}
      />,
    );
    expect(screen.getByText('已安装')).toBeTruthy();
  });

  it('⑩ plugin 源资源 + 来源插件停用：「插件已停用」徽标（矩阵 C7 管理面保留卡）', () => {
    render(
      <ResourceCard
        item={mkItem({
          id: 'plugin-mcp-cgx', source: 'plugin', slug: 'cgx', pluginDisabled: true, removable: false,
        })}
        selected={false} onSelect={noop}
      />,
    );
    expect(screen.getByText('插件已停用')).toBeTruthy();
  });
});

describe('ResourceCard 五源并列渲染（M1 Task 10 回归锁）', () => {
  it('builtin / marketplace / custom / smithery / hub 五源卡片同屏渲染，各挂自己的来源徽标', () => {
    const sources: Array<{ source: ResourceItem['source']; label: string }> = [
      { source: 'builtin', label: '系统预置' },
      { source: 'marketplace', label: '网络资源' },
      { source: 'custom', label: '自定义' },
      { source: 'smithery', label: 'Smithery' },
      { source: 'hub', label: 'momo-hub' },
    ];
    render(
      <div role="list">
        {sources.map((s, i) => (
          <ResourceCard
            key={s.source}
            item={mkItem({
              id: `${s.source}-mcp-x${i}`, type: 'mcp', source: s.source, slug: `x${i}`,
              name: `卡${i}`, installed: false, installable: true, removable: false,
            })}
            selected={false} onSelect={noop} onInstall={noop}
          />
        ))}
      </div>,
    );
    // 五个来源徽标同时在场——不互相遮蔽（source 标签契约锁）
    for (const s of sources) {
      expect(screen.getByText(s.label)).toBeTruthy();
    }
    // 五张卡各自的来源标签不串位
    expect(screen.getAllByText(/系统预置|网络资源|自定义|Smithery|momo-hub/)).toHaveLength(5);
  });

  it('hub 未装条目显示安装钮（installable）——安装走 resource:install 的 hub 分支', () => {
    const onInstall = vi.fn();
    render(
      <ResourceCard
        item={mkItem({
          id: 'hub-agent-hub-e2e-agent', type: 'agent', source: 'hub', slug: 'hub-e2e-agent',
          name: '演示 Agent', installed: false, installable: true, removable: false,
        })}
        selected={false} onSelect={noop} onInstall={onInstall}
      />,
    );
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy();
    expect(screen.getByText('momo-hub')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith('hub-agent-hub-e2e-agent');
  });
});

describe('ResourceCard 插件面（spec 2026-10-21 §9①：恒显徽标 + 卡内启停开关）', () => {
  function mkPlugin(over: Partial<NonNullable<ResourceItem['plugin']>>): ResourceItem {
    return mkItem({
      id: 'custom-plugin-cg', type: 'plugin', slug: 'cg',
      plugin: { id: 'cg', state: 'active', devSource: true, sourcePath: '/x', components: ['mcp'], enabled: false, ...over },
    });
  }

  it('启用态：徽标「已启用」+ switch aria-checked=true；点 switch 回调 next=false 且不冒泡', () => {
    const onTogglePlugin = vi.fn();
    const onSelect = vi.fn();
    render(
      <ResourceCard item={mkPlugin({ enabled: true })} selected={false}
        onSelect={onSelect} onTogglePlugin={onTogglePlugin} />,
    );
    expect(screen.getByText('已启用')).toBeTruthy();
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onTogglePlugin).toHaveBeenCalledWith(expect.objectContaining({ slug: 'cg' }), false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('停用态：徽标「已停用」+ aria-checked=false；missing：徽标「目录缺失」+ 开关禁用', () => {
    const { rerender } = render(
      <ResourceCard item={mkPlugin({ enabled: false })} selected={false}
        onSelect={noop} onTogglePlugin={noop} />,
    );
    expect(screen.getByText('已停用')).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    rerender(
      <ResourceCard item={mkPlugin({ enabled: false, state: 'missing' })} selected={false}
        onSelect={noop} onTogglePlugin={noop} />,
    );
    expect(screen.getByText('目录缺失')).toBeTruthy();
    const sw = screen.getByRole('switch') as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
  });
});

describe('ResourceCard 发布到 hub 入口（M1 Task 14 + M2.2 Task 2：custom 四类型 + marketplace 已装 skill × 接入态矩阵）', () => {
  const pluginNs = { id: 'cg-plugin', state: 'active' as const, devSource: false, sourcePath: null, components: [], enabled: true };

  it('四类型 custom 卡均渲染「发布到 hub」；点击不冒泡并回传整 item', () => {
    const onPublish = vi.fn();
    const onSelect = vi.fn();
    const types = ['agent', 'skill', 'mcp', 'plugin'] as const;
    render(
      <div role="list">
        {types.map((t) => (
          <ResourceCard
            key={t}
            item={mkItem({
              id: `custom-${t}-x`, type: t, slug: `${t}-x`, name: `卡${t}`,
              ...(t === 'plugin' ? { plugin: { ...pluginNs, id: 'plugin-x' } } : {}),
            })}
            selected={false} onSelect={onSelect} hubEnrolled onPublishToHub={onPublish}
          />
        ))}
      </div>,
    );
    const btns = screen.getAllByRole('button', { name: '发布到 hub' });
    expect(btns).toHaveLength(4);
    fireEvent.click(btns[0]!);
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('非 custom 源（builtin/marketplace/smithery/hub）不渲染发布入口', () => {
    render(
      <div role="list">
        {(['builtin', 'marketplace', 'smithery', 'hub'] as const).map((s) => (
          <ResourceCard
            key={s}
            item={mkItem({ id: `${s}-mcp-y`, source: s, slug: 'y', name: `卡${s}`, installed: false, installable: true, removable: false })}
            selected={false} onSelect={noop} hubEnrolled onPublishToHub={noop}
          />
        ))}
      </div>,
    );
    expect(screen.queryByRole('button', { name: '发布到 hub' })).toBeNull();
  });

  // ── M2.2 Task 2 扩面：marketplace 源 skill（superpowers 类主场景）────────────
  it('marketplace 已装 skill 卡渲染「发布到 hub」；点击不冒泡并回传整 item', () => {
    const onPublish = vi.fn();
    const onSelect = vi.fn();
    const item = mkItem({
      id: 'marketplace-skill-superpowers-brainstorm',
      type: 'skill', source: 'marketplace', slug: 'superpowers-brainstorm',
      name: '头脑风暴', installed: true, installable: false, removable: true,
      version: '1.4.0',
    });
    render(<ResourceCard item={item} selected={false} onSelect={onSelect} hubEnrolled onPublishToHub={onPublish} />);
    const btn = screen.getByRole('button', { name: '发布到 hub' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onPublish).toHaveBeenCalledWith(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marketplace 未装 skill 卡不渲染发布入口（无本地包可打——发布语义=本机已装且愿意分发）', () => {
    render(
      <ResourceCard
        item={mkItem({
          id: 'marketplace-skill-y', type: 'skill', source: 'marketplace', slug: 'y',
          name: '未装技能', installed: false, installable: true, removable: false,
        })}
        selected={false} onSelect={noop} hubEnrolled onPublishToHub={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: '发布到 hub' })).toBeNull();
  });

  it('marketplace 已装 agent/mcp 卡不渲染发布入口（C3 维持仅 custom——主进程同样拒绝，UI 不给死路入口）', () => {
    render(
      <div role="list">
        {(['agent', 'mcp'] as const).map((t) => (
          <ResourceCard
            key={t}
            item={mkItem({
              id: `marketplace-${t}-y`, type: t, source: 'marketplace', slug: 'y', name: `卡${t}`,
              installed: true, installable: false, removable: false,
            })}
            selected={false} onSelect={noop} hubEnrolled onPublishToHub={noop}
          />
        ))}
      </div>,
    );
    expect(screen.queryByRole('button', { name: '发布到 hub' })).toBeNull();
  });

  it('未接入（hubEnrolled=false）：入口禁用 + title 引导去设置', () => {
    render(
      <ResourceCard
        item={mkItem({})} selected={false} onSelect={noop}
        hubEnrolled={false} onPublishToHub={noop}
      />,
    );
    const btn = screen.getByRole('button', { name: '发布到 hub' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/未接入 momo-hub/);
  });

  it('onPublishToHub 缺席（未接线调用方）不渲染入口——prop 可选回归', () => {
    render(<ResourceCard item={mkItem({})} selected={false} onSelect={noop} hubEnrolled />);
    expect(screen.queryByRole('button', { name: '发布到 hub' })).toBeNull();
  });
});

describe('ResourceCard hub 可更新角标（M1 Task 14：事件链末端徽标）', () => {
  const hubItem = (over: Partial<ResourceItem> = {}): ResourceItem =>
    mkItem({
      id: 'hub-agent-meeting', type: 'agent', source: 'hub', slug: 'meeting',
      name: '会议纪要生成器', version: '1.1.0', installed: true, installable: false, removable: true,
      ...over,
    });

  it('已装 + 事件版本较新：warning「可更新」徽标 + v1.1.0 → v1.2.0 + 「更新」按钮走 onInstall 安装链', () => {
    const onInstall = vi.fn();
    render(
      <ResourceCard
        item={hubItem()} selected={false} onSelect={noop} onInstall={onInstall}
        hubUpdates={{ 'agent:meeting': '1.2.0' }}
      />,
    );
    expect(screen.getByText('可更新')).toBeTruthy();
    expect(screen.getByText('v1.1.0 → v1.2.0')).toBeTruthy();
    expect(screen.queryByText(/已是最新/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    expect(onInstall).toHaveBeenCalledWith('hub-agent-meeting');
  });

  it('事件版本等于已装版本：已是最新形态（v1.1.0 · 已是最新），不占徽标', () => {
    render(
      <ResourceCard
        item={hubItem()} selected={false} onSelect={noop}
        hubUpdates={{ 'agent:meeting': '1.1.0' }}
      />,
    );
    expect(screen.queryByText('可更新')).toBeNull();
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
    expect(screen.getByText('v1.1.0 · 已是最新')).toBeTruthy();
  });

  // D7（M2 Task 1）：角标锚 installedVersion（已装版）而非 item.version（目录 head）。
  // M1 T14 报告「已是最新断言盲区」：目录先行 + 事件迟到时 item.version 已是目录
  // head、与事件版本恒等 → 旧锚点把物理旧版误判「已是最新」
  it('D7 目录先行 + 事件迟到（version=head、installedVersion=旧版、事件版本=head）→ 锚 installedVersion 显示可更新', () => {
    const onInstall = vi.fn();
    render(
      <ResourceCard
        item={hubItem({ version: '1.2.0', installedVersion: '1.0.0' })}
        selected={false} onSelect={noop} onInstall={onInstall}
        hubUpdates={{ 'agent:meeting': '1.2.0' }}
      />,
    );
    expect(screen.getByText('可更新')).toBeTruthy();
    expect(screen.getByText('v1.0.0 → v1.2.0')).toBeTruthy();
    expect(screen.queryByText(/已是最新/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    expect(onInstall).toHaveBeenCalledWith('hub-agent-meeting');
  });

  it('D7 已是最新文案同锚 installedVersion（无事件时显示 v1.0.0 · 已是最新而非目录 head）', () => {
    render(
      <ResourceCard
        item={hubItem({ version: '1.2.0', installedVersion: '1.0.0' })}
        selected={false} onSelect={noop}
      />,
    );
    expect(screen.getByText('v1.0.0 · 已是最新')).toBeTruthy();
    expect(screen.queryByText(/v1\.2\.0/)).toBeNull();
  });

  it('事件版本等于已装版本（installedVersion 在场）：已是最新形态', () => {
    render(
      <ResourceCard
        item={hubItem({ version: '1.2.0', installedVersion: '1.2.0' })}
        selected={false} onSelect={noop}
        hubUpdates={{ 'agent:meeting': '1.2.0' }}
      />,
    );
    expect(screen.queryByText('可更新')).toBeNull();
    expect(screen.getByText('v1.2.0 · 已是最新')).toBeTruthy();
  });

  it('事件缺席（hubUpdates 无该键）：已装 hub 卡同为已是最新形态', () => {
    render(<ResourceCard item={hubItem()} selected={false} onSelect={noop} />);
    expect(screen.getByText('v1.1.0 · 已是最新')).toBeTruthy();
    expect(screen.queryByText('可更新')).toBeNull();
  });

  it('未装 hub 卡：不显示已是最新也不显示角标（安装钮语义不变）', () => {
    const onInstall = vi.fn();
    render(
      <ResourceCard
        item={hubItem({ installed: false, installable: true, removable: false })}
        selected={false} onSelect={noop} onInstall={onInstall}
        hubUpdates={{ 'agent:meeting': '1.2.0' }}
      />,
    );
    expect(screen.queryByText(/已是最新/)).toBeNull();
    expect(screen.queryByText('可更新')).toBeNull();
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy();
  });

  it('非 hub 源不受 hubUpdates 影响（custom 卡无角标无已是最新）', () => {
    render(
      <ResourceCard
        item={mkItem({ version: '1.0.0' })} selected={false} onSelect={noop}
        hubUpdates={{ 'mcp:x': '2.0.0' }}
      />,
    );
    expect(screen.queryByText(/已是最新/)).toBeNull();
    expect(screen.queryByText('可更新')).toBeNull();
  });
});

// ── M2.3 T2 D3-4：角标判定 semver 前进（裁定书 p1-0 §3）──────────────────────
// 旧判定 = 字符串不等（hubLatest !== installedAnchor）：乱序发布低版本事件也
// offer「可更新」（点击即降级）；'1.0' vs '1.0.0' 缺段相等误报可更新。
// 新判定 = compareVersions(hubLatest, installedAnchor) > 0——semver 前进才可更新。
describe('ResourceCard hub 角标 semver 判定（M2.3 T2 D3-4）', () => {
  const hubSkill = (over: Partial<ResourceItem> = {}): ResourceItem =>
    mkItem({
      id: 'hub-skill-pdf-summary', type: 'skill', source: 'hub', slug: 'pdf-summary',
      name: 'PDF 摘要器', installed: true, installable: false, removable: true,
      ...over,
    });

  it('字典序陷阱：事件 1.10.0 > 已装 1.9.0 → 可更新（字符串序会误判 1.10.0 < 1.9.0）', () => {
    const onInstall = vi.fn();
    render(
      <ResourceCard
        item={hubSkill({ installedVersion: '1.9.0' })} selected={false} onSelect={noop} onInstall={onInstall}
        hubUpdates={{ 'skill:pdf-summary': '1.10.0' }}
      />,
    );
    expect(screen.getByText('可更新')).toBeTruthy();
    expect(screen.getByText('v1.9.0 → v1.10.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    expect(onInstall).toHaveBeenCalledWith('hub-skill-pdf-summary');
  });

  it('缺段相等（Review Focus 1）：事件 1.0.0 vs 已装 1.0 → 已是最新，无更新按钮', () => {
    render(
      <ResourceCard
        item={hubSkill({ installedVersion: '1.0' })} selected={false} onSelect={noop}
        hubUpdates={{ 'skill:pdf-summary': '1.0.0' }}
      />,
    );
    expect(screen.getByText('v1.0 · 已是最新')).toBeTruthy();
    expect(screen.queryByText('可更新')).toBeNull();
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
  });

  it('乱序低版本事件：事件 1.5.0 < 已装 2.0.0 → 已是最新，不 offer 降级', () => {
    render(
      <ResourceCard
        item={hubSkill({ installedVersion: '2.0.0' })} selected={false} onSelect={noop}
        hubUpdates={{ 'skill:pdf-summary': '1.5.0' }}
      />,
    );
    expect(screen.getByText('v2.0.0 · 已是最新')).toBeTruthy();
    expect(screen.queryByText('可更新')).toBeNull();
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
  });
});

describe('ResourceCard 2D 键盘导航（列数按 offsetTop 动态推导）', () => {
  /** 模拟 2 行 × 3 列网格。jsdom 无布局引擎——Object.defineProperty 注入
   *  offsetTop 仿真浏览器「同值 offsetTop = 同一视觉行」的真实分组语义。 */
  function renderGrid(): HTMLElement[] {
    const items = [0, 1, 2, 3, 4, 5].map((n) =>
      mkItem({ id: `custom-mcp-${n}`, slug: `s${n}`, name: `卡${n}`, removable: false }));
    const { container } = render(
      <div role="list">
        {items.map((item) => (
          <ResourceCard key={item.id} item={item} selected={false} onSelect={noop} />
        ))}
      </div>,
    );
    const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="resource-card-"]'));
    const tops = [0, 0, 0, 100, 100, 100];
    cards.forEach((el, i) => Object.defineProperty(el, 'offsetTop', { value: tops[i], configurable: true }));
    return cards;
  }

  it('Enter/Space 选中卡片', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <div role="list">
        <ResourceCard item={mkItem({})} selected={false} onSelect={onSelect} />
      </div>,
    );
    const card = container.querySelector<HTMLElement>('[data-testid="resource-card-custom-mcp-x"]');
    if (!card) throw new Error('卡片未渲染');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith('custom-mcp-x');
  });

  /** strict 取值：noUncheckedIndexedAccess 下索引访问可能 undefined，缺失即测试自身装配失败 */
  function at(cards: HTMLElement[], i: number): HTMLElement {
    const el = cards[i];
    if (!el) throw new Error(`卡 ${i} 未渲染`);
    return el;
  }

  it('↓/↑ 按整行跳（3 列网格 0→3→0）；末行向下越界钳制到最后一张', () => {
    const cards = renderGrid();
    at(cards, 0).focus();
    fireEvent.keyDown(at(cards, 0), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(at(cards, 3));
    fireEvent.keyDown(at(cards, 3), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(at(cards, 0));
    // 卡4（idx 4 + 3 列 = 7 > 5）→ 钳制到末张（网格惯例，不跳界崩溃）
    at(cards, 4).focus();
    fireEvent.keyDown(at(cards, 4), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(at(cards, 5));
  });

  it('←/→ 相邻移动，首卡左移不动；Home/End 到首末', () => {
    const cards = renderGrid();
    at(cards, 0).focus();
    fireEvent.keyDown(at(cards, 0), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(at(cards, 1));
    fireEvent.keyDown(at(cards, 1), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(at(cards, 0));
    fireEvent.keyDown(at(cards, 0), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(at(cards, 0));
    at(cards, 2).focus();
    fireEvent.keyDown(at(cards, 2), { key: 'Home' });
    expect(document.activeElement).toBe(at(cards, 0));
    fireEvent.keyDown(at(cards, 2), { key: 'End' });
    expect(document.activeElement).toBe(at(cards, 5));
  });

  it('列数随重排自适应：全部同 offsetTop（拉宽后单行）时 ↓ 钳制到末张', () => {
    const cards = renderGrid();
    // 容器拉宽 → 6 卡全进一行（同 offsetTop；jsdom 默认值 0 即此语义）
    cards.forEach((el) => Object.defineProperty(el, 'offsetTop', { value: 0, configurable: true }));
    at(cards, 0).focus();
    fireEvent.keyDown(at(cards, 0), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(at(cards, 5));
  });
});
