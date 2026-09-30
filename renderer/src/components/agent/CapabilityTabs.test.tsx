// renderer/src/components/agent/CapabilityTabs.test.tsx
//
// CapabilityTabs 共享组件测试：三 Tab（工具 / MCP / Skill）+ 类别分组 checkbox。
// 三种模式：
//   - edit：value 是绝对勾选集合（DefinitionEditor 自定义 agent 编辑用）
//   - override：value 是最终值，调用方对照 defaultValue 计算 delta（Layer 3 弹窗用）
//   - readonly：checkbox disabled（builtin agent configure 模式用）
// 底部三个快捷按钮：[全选] [清空] [安全最小集]（仅 edit 模式工具 Tab 显示）
//
// v2.x 切源：工具目录来自 IPC tools:getCatalog（mock 小目录：2 个 defaultOn +
// 1 个 defaultOn=false），既有用例的勾选/清空/最小集断言全部改用 mock 目录里的
// 名字；目录异步就绪，工具相关查询一律 find* 等待。
//
// 注意：CapabilityTabs 只管最终值（绝对勾选集合）；delta 计算交由调用方负责，
// 故 override 模式的测试只验证 checkbox 反映最终值，不验证 delta 输出。
//
// 模块级缓存说明：useToolCatalog 成功后 cache 常驻模块实例。加载态/错误态用例
// 必须在 vi.resetModules() 后动态 import 组件，拿到全新 hook 状态才能真实触发。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ToolCatalogEntry } from '../../ipc/types';
import { CapabilityTabs, type CapabilityTabsProps } from './CapabilityTabs';

/**
 * 加载态/错误态用例专用：beforeEach 已 resetModules，动态 import 拿到全新组件
 * 与全新 useToolCatalog 模块实例（cache=null），否则命中模块级缓存无法触发
 * 加载/失败路径。返回类型与静态导入同名组件一致。
 */
async function importFreshComponent(): Promise<typeof CapabilityTabs> {
  const mod = await import('./CapabilityTabs');
  return mod.CapabilityTabs;
}

// vi.hoisted 保证 mock fn 在 vi.mock 工厂（会被提升到文件顶部）执行时已存在，
// 同时能在每个 test 内通过 mockResolvedValueOnce 精确控制返回值。
// v1.7：mcp + skill 都走统一 ipc.resource.list({ type })，单 mock 按 filter.type 分流。
// v2.x：工具目录走 tools.getCatalog（与生产路径一致，拦截真实依赖边界）。
const { mockResourceList, mockGetCatalog } = vi.hoisted(() => ({
  mockResourceList: vi.fn(),
  mockGetCatalog: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  ipc: {
    resource: { list: mockResourceList },
    tools: { getCatalog: mockGetCatalog },
  },
}));

/** 模拟 IPC 目录：2 个 defaultOn + 1 个 defaultOn=false（brief Step 5c 规格小目录） */
const MOCK_CATALOG: ToolCatalogEntry[] = [
  { name: 'read_file', description: '读文件', category: '文件', categoryEmoji: '📁', defaultOn: true },
  { name: 'write_file', description: '写文件', category: '文件', categoryEmoji: '📁', defaultOn: true },
  { name: 'bash', description: '执行命令', category: 'Shell', categoryEmoji: '💻', defaultOn: false },
];
/** mock 目录派生：defaultOn 集（= 安全最小集）与全集，断言一律用这两份 */
const MOCK_SAFE_MINIMUM = ['read_file', 'write_file'];
const MOCK_ALL_TOOLS = ['read_file', 'write_file', 'bash'];

beforeEach(() => {
  // 清模块注册表：配合 importFreshComponent 拿全新 hook 状态（静态导入不受影响）
  vi.resetModules();
  // 默认空：任意 type 查询都返回空数组（Tab 切换到空态用例依赖此默认）
  mockResourceList.mockResolvedValue([]);
  mockGetCatalog.mockResolvedValue(MOCK_CATALOG);
});

/** 默认 edit 模式 props（方便每个 case 覆盖单字段） */
function defaultProps(overrides: Partial<CapabilityTabsProps> = {}): CapabilityTabsProps {
  return {
    mode: 'edit',
    value: { tools: [...MOCK_SAFE_MINIMUM], mcps: [], skills: [] },
    onChange: vi.fn(),
    ...overrides,
  };
}

describe('CapabilityTabs — Tab 结构', () => {
  it('渲染三个 Tab：工具 / MCP / Skill', async () => {
    render(<CapabilityTabs {...defaultProps()} />);
    expect(screen.getByText('工具')).toBeInTheDocument();
    expect(screen.getByText('MCP')).toBeInTheDocument();
    expect(screen.getByText('Skill')).toBeInTheDocument();
  });

  it('默认显示工具 Tab（含文件类别 emoji 📁）', async () => {
    render(<CapabilityTabs {...defaultProps()} />);
    // 工具 Tab 是激活态：类别标题里应能搜到文件类的 emoji + label（目录异步就绪，find 等待）
    expect(await screen.findByText(/📁/)).toBeInTheDocument();
    expect(screen.getByText(/文件/)).toBeInTheDocument();
  });

  it('点击 MCP Tab 切换到 MCP 面板', async () => {
    render(<CapabilityTabs {...defaultProps()} />);
    fireEvent.click(screen.getByText('MCP'));
    await waitFor(() => {
      expect(screen.getByText(/尚未注册任何 MCP/)).toBeInTheDocument();
    });
  });

  it('点击 Skill Tab 切换到 Skill 面板', async () => {
    render(<CapabilityTabs {...defaultProps()} />);
    fireEvent.click(screen.getByText('Skill'));
    await waitFor(() => {
      expect(screen.getByText(/尚未安装任何 Skill/)).toBeInTheDocument();
    });
  });
});

describe('CapabilityTabs — 工具目录加载态与错误态', () => {
  it('目录未就绪时工具 Tab 顶部显示加载提示（text-tertiary，非错误色）', async () => {
    mockGetCatalog.mockReturnValue(new Promise(() => {}));
    const Fresh = await importFreshComponent();
    render(<Fresh {...defaultProps()} />);
    const loading = screen.getByText('工具目录加载中…');
    expect(loading).toBeInTheDocument();
    // 终审 Finding 3：加载≠错误——加载中用 text-tertiary，不得共用错误色
    expect(loading).toHaveClass('text-tertiary');
    expect(loading).not.toHaveClass('text-status-error');
  });

  it('目录加载失败时显示错误文案（分组区为空、不阻塞表单其余部分）', async () => {
    mockGetCatalog.mockRejectedValue(new Error('IPC 崩了'));
    const Fresh = await importFreshComponent();
    render(<Fresh {...defaultProps()} />);
    const err = await screen.findByText(/工具目录加载失败：IPC 崩了/);
    expect(err).toBeInTheDocument();
    expect(err).toHaveClass('text-status-error');
    expect(screen.queryByLabelText('read_file')).not.toBeInTheDocument();
  });

  it('目录未就绪时 [全选] / [安全最小集] disabled，[清空] 可用', async () => {
    mockGetCatalog.mockReturnValue(new Promise(() => {}));
    const Fresh = await importFreshComponent();
    render(<Fresh {...defaultProps()} />);
    expect(screen.getByText('全选')).toBeDisabled();
    expect(screen.getByText('安全最小集')).toBeDisabled();
    expect(screen.getByText('清空')).not.toBeDisabled();
  });
});

describe('CapabilityTabs — edit 模式', () => {
  it('value 中的工具默认勾选（read_file 属于 mock 目录 defaultOn 集）', async () => {
    render(<CapabilityTabs {...defaultProps()} />);
    const cb = await screen.findByLabelText('read_file');
    expect((cb as HTMLInputElement).checked).toBe(true);
  });

  it('value 之外的工具默认不勾选（bash defaultOn=false）', async () => {
    render(<CapabilityTabs {...defaultProps()} />);
    const cb = await screen.findByLabelText('bash');
    expect((cb as HTMLInputElement).checked).toBe(false);
  });

  it('勾选一个未选工具 → onChange 加入该工具', async () => {
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(await screen.findByLabelText('bash'));
    expect(onChange).toHaveBeenCalledWith({
      tools: expect.arrayContaining([...MOCK_SAFE_MINIMUM, 'bash']),
      mcps: [],
      skills: [],
    });
    // 原有工具数量 + 1
    const call = onChange.mock.calls[0][0];
    expect(call.tools).toHaveLength(MOCK_SAFE_MINIMUM.length + 1);
  });

  it('取消一个已选工具 → onChange 移除该工具', async () => {
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(await screen.findByLabelText('read_file'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0][0];
    expect(call.tools).not.toContain('read_file');
    expect(call.tools).toHaveLength(MOCK_SAFE_MINIMUM.length - 1);
  });

  it('checkbox 不 disabled（可交互）', async () => {
    render(<CapabilityTabs {...defaultProps()} />);
    expect(await screen.findByLabelText('bash')).not.toBeDisabled();
  });

  it('显示三个快捷按钮：全选 / 清空 / 安全最小集', async () => {
    render(<CapabilityTabs {...defaultProps()} />);
    await screen.findByLabelText('read_file');
    expect(screen.getByText('全选')).toBeInTheDocument();
    expect(screen.getByText('清空')).toBeInTheDocument();
    expect(screen.getByText('安全最小集')).toBeInTheDocument();
  });

  it('点击 [全选] → onChange 设置为 mock 目录全集', async () => {
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(await screen.findByText('全选'));
    expect(onChange).toHaveBeenCalledWith({
      tools: [...MOCK_ALL_TOOLS],
      mcps: [],
      skills: [],
    });
  });

  it('点击 [清空] → onChange 设置为空工具集', async () => {
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    await screen.findByLabelText('read_file');
    fireEvent.click(screen.getByText('清空'));
    expect(onChange).toHaveBeenCalledWith({
      tools: [],
      mcps: [],
      skills: [],
    });
  });

  it('点击 [安全最小集] → onChange 重置为 mock 目录 defaultOn 集', async () => {
    const onChange = vi.fn();
    render(
      <CapabilityTabs
        {...defaultProps({
          value: { tools: ['bash'], mcps: [], skills: [] },
          onChange,
        })}
      />,
    );
    fireEvent.click(await screen.findByText('安全最小集'));
    expect(onChange).toHaveBeenCalledWith({
      tools: [...MOCK_SAFE_MINIMUM],
      mcps: [],
      skills: [],
    });
  });
});

describe('CapabilityTabs — readonly 模式（builtin configure）', () => {
  it('所有工具 checkbox disabled', async () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'readonly',
          value: { tools: ['read_file'], mcps: [], skills: [] },
        })}
      />,
    );
    // 勾选的 disabled
    expect(await screen.findByLabelText('read_file')).toBeDisabled();
    // 未勾选的也 disabled
    expect(screen.getByLabelText('bash')).toBeDisabled();
  });

  it('不渲染快捷按钮（全选/清空/安全最小集 都不出现）', async () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'readonly',
          value: { tools: ['read_file'], mcps: [], skills: [] },
        })}
      />,
    );
    expect(screen.queryByText('全选')).not.toBeInTheDocument();
    expect(screen.queryByText('清空')).not.toBeInTheDocument();
    expect(screen.queryByText('安全最小集')).not.toBeInTheDocument();
  });

  it('点击 disabled checkbox 不触发 onChange', async () => {
    const onChange = vi.fn();
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'readonly',
          value: { tools: ['read_file'], mcps: [], skills: [] },
          onChange,
        })}
      />,
    );
    // disabled 的 checkbox 点击不会触发 change 事件
    const cb = await screen.findByLabelText('bash');
    expect(cb).toBeDisabled();
    expect((cb as HTMLInputElement).checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('CapabilityTabs — override 模式（Layer 3 弹窗）', () => {
  it('checkbox 反映 value 最终值（非 defaultValue）', async () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'override',
          defaultValue: { tools: ['read_file'], mcps: [], skills: [] },
          value: { tools: ['read_file', 'bash'], mcps: [], skills: [] },
        })}
      />,
    );
    expect((await screen.findByLabelText('read_file') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('bash') as HTMLInputElement).checked).toBe(true);
    // write_file 既不在 default 也不在 value → 未勾
    expect((screen.getByLabelText('write_file') as HTMLInputElement).checked).toBe(false);
  });

  it('checkbox 可交互（不 disabled）', async () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'override',
          defaultValue: { tools: ['read_file'], mcps: [], skills: [] },
          value: { tools: ['read_file'], mcps: [], skills: [] },
        })}
      />,
    );
    expect(await screen.findByLabelText('bash')).not.toBeDisabled();
  });

  it('不渲染快捷按钮（override 模式下用户精细调整，不提供批量操作）', () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'override',
          defaultValue: { tools: ['read_file'], mcps: [], skills: [] },
          value: { tools: ['read_file'], mcps: [], skills: [] },
        })}
      />,
    );
    expect(screen.queryByText('全选')).not.toBeInTheDocument();
    expect(screen.queryByText('安全最小集')).not.toBeInTheDocument();
  });

  it('显示默认值提示文案（让用户知道 def+ws 默认是什么）', () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'override',
          defaultValue: { tools: ['read_file', 'write_file'], mcps: [], skills: [] },
          value: { tools: ['read_file'], mcps: [], skills: [] },
        })}
      />,
    );
    // 提示里应列出默认工具
    expect(screen.getByText(/read_file.*write_file|write_file.*read_file/)).toBeInTheDocument();
  });
});

describe('CapabilityTabs — MCP Tab 动态列表', () => {
  it('ipc.resource.list type=mcp 返回的 MCP 渲染为可勾选项', async () => {
    mockResourceList.mockImplementation(async (filter?: { type?: string }) => {
      if (filter?.type !== 'mcp') return [];
      return [
        {
          id: 'custom-mcp-filesystem',
          type: 'mcp',
          source: 'custom',
          slug: 'filesystem',
          name: 'filesystem',
          description: '',
          installed: true,
          installable: false,
          removable: true,
        },
      ];
    });
    render(<CapabilityTabs {...defaultProps()} />);
    fireEvent.click(screen.getByText('MCP'));
    await waitFor(() => {
      expect(screen.getByLabelText('filesystem')).toBeInTheDocument();
    });
  });

  it('勾选 MCP → onChange.mcps 加入', async () => {
    mockResourceList.mockImplementation(async (filter?: { type?: string }) => {
      if (filter?.type !== 'mcp') return [];
      return [
        {
          id: 'marketplace-mcp-github',
          type: 'mcp',
          source: 'marketplace',
          slug: 'github',
          name: 'github',
          description: '',
          installed: true,
          installable: false,
          removable: true,
        },
      ];
    });
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByText('MCP'));
    await waitFor(() => {
      expect(screen.getByLabelText('github')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('github'));
    expect(onChange).toHaveBeenCalledWith({
      tools: [...MOCK_SAFE_MINIMUM],
      mcps: ['github'],
      skills: [],
    });
  });

  it('未安装的 MCP 不展示（filter i.installed）', async () => {
    mockResourceList.mockImplementation(async (filter?: { type?: string }) => {
      if (filter?.type !== 'mcp') return [];
      return [
        {
          id: 'marketplace-mcp-remote',
          type: 'mcp',
          source: 'marketplace',
          slug: 'remote',
          name: 'remote',
          description: '',
          installed: false,
          installable: true,
          removable: false,
        },
      ];
    });
    render(<CapabilityTabs {...defaultProps()} />);
    fireEvent.click(screen.getByText('MCP'));
    await waitFor(() => {
      expect(screen.getByText(/尚未注册任何 MCP/)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('remote')).not.toBeInTheDocument();
  });
});

describe('CapabilityTabs — Skill Tab 动态列表', () => {
  it('ipc.resource.list type=skill 返回的 Skill 渲染为可勾选项', async () => {
    mockResourceList.mockImplementation(async (filter?: { type?: string }) => {
      if (filter?.type !== 'skill') return [];
      return [
        {
          id: 'builtin-skill-code-review',
          type: 'skill',
          source: 'builtin',
          slug: 'code-review',
          name: '代码审查',
          description: '审查代码变更',
          installed: true,
          installable: false,
          removable: false,
        },
      ];
    });
    render(<CapabilityTabs {...defaultProps()} />);
    fireEvent.click(screen.getByText('Skill'));
    await waitFor(() => {
      expect(screen.getByLabelText('code-review')).toBeInTheDocument();
    });
  });

  it('勾选 Skill → onChange.skills 加入', async () => {
    mockResourceList.mockImplementation(async (filter?: { type?: string }) => {
      if (filter?.type !== 'skill') return [];
      return [
        {
          id: 'builtin-skill-debugging',
          type: 'skill',
          source: 'builtin',
          slug: 'debugging',
          name: '调试',
          description: '系统化调试流程',
          installed: true,
          installable: false,
          removable: false,
        },
      ];
    });
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByText('Skill'));
    await waitFor(() => {
      expect(screen.getByLabelText('debugging')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('debugging'));
    expect(onChange).toHaveBeenCalledWith({
      tools: [...MOCK_SAFE_MINIMUM],
      mcps: [],
      skills: ['debugging'],
    });
  });
});
