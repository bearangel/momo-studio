// renderer/src/components/agent/CapabilityTabs.test.tsx
//
// CapabilityTabs 共享组件测试：三 Tab（工具 / MCP / Skill）+ 类别分组 checkbox。
// 三种模式：
//   - edit：value 是绝对勾选集合（DefinitionEditor 自定义 agent 编辑用）
//   - override：value 是最终值，调用方对照 defaultValue 计算 delta（Layer 3 弹窗用）
//   - readonly：checkbox disabled（builtin agent configure 模式用）
// 底部三个快捷按钮：[全选] [清空] [安全最小集]（仅 edit 模式工具 Tab 显示）
//
// 注意：CapabilityTabs 只管最终值（绝对勾选集合）；delta 计算交由调用方负责，
// 故 override 模式的测试只验证 checkbox 反映最终值，不验证 delta 输出。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  CapabilityTabs,
  type CapabilityTabsProps,
} from './CapabilityTabs';
import { SAFE_MINIMUM_TOOLS, ALL_BUILTIN_TOOLS } from '../../lib/tool-catalog';

// vi.hoisted 保证 mock fn 在 vi.mock 工厂（会被提升到文件顶部）执行时已存在，
// 同时能在每个 test 内通过 mockResolvedValueOnce 精确控制返回值。
// v1.7：mcp + skill 都走统一 ipc.resource.list({ type })，单 mock 按 filter.type 分流。
const { mockResourceList } = vi.hoisted(() => ({
  mockResourceList: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  ipc: {
    resource: { list: mockResourceList },
  },
}));

beforeEach(() => {
  // 默认空：任意 type 查询都返回空数组（Tab 切换到空态用例依赖此默认）
  mockResourceList.mockResolvedValue([]);
});

/** 默认 edit 模式 props（方便每个 case 覆盖单字段） */
function defaultProps(overrides: Partial<CapabilityTabsProps> = {}): CapabilityTabsProps {
  return {
    mode: 'edit',
    value: { tools: [...SAFE_MINIMUM_TOOLS], mcps: [], skills: [] },
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
    // 工具 Tab 是激活态：类别标题里应能搜到文件类的 emoji + label
    expect(screen.getByText(/📁/)).toBeInTheDocument();
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

describe('CapabilityTabs — edit 模式', () => {
  it('value 中的工具默认勾选（read_file 属于安全最小集）', () => {
    render(<CapabilityTabs {...defaultProps()} />);
    const cb = screen.getByLabelText('read_file') as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('value 之外的工具默认不勾选（bash 不在安全最小集）', () => {
    render(<CapabilityTabs {...defaultProps()} />);
    const cb = screen.getByLabelText('bash') as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('勾选一个未选工具 → onChange 加入该工具', () => {
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByLabelText('bash'));
    expect(onChange).toHaveBeenCalledWith({
      tools: expect.arrayContaining([...SAFE_MINIMUM_TOOLS, 'bash']),
      mcps: [],
      skills: [],
    });
    // 原有工具数量 + 1
    const call = onChange.mock.calls[0][0];
    expect(call.tools).toHaveLength(SAFE_MINIMUM_TOOLS.length + 1);
  });

  it('取消一个已选工具 → onChange 移除该工具', () => {
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByLabelText('read_file'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0][0];
    expect(call.tools).not.toContain('read_file');
    expect(call.tools).toHaveLength(SAFE_MINIMUM_TOOLS.length - 1);
  });

  it('checkbox 不 disabled（可交互）', () => {
    render(<CapabilityTabs {...defaultProps()} />);
    expect(screen.getByLabelText('bash')).not.toBeDisabled();
  });

  it('显示三个快捷按钮：全选 / 清空 / 安全最小集', () => {
    render(<CapabilityTabs {...defaultProps()} />);
    expect(screen.getByText('全选')).toBeInTheDocument();
    expect(screen.getByText('清空')).toBeInTheDocument();
    expect(screen.getByText('安全最小集')).toBeInTheDocument();
  });

  it('点击 [全选] → onChange 设置为全部 24 工具', () => {
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByText('全选'));
    expect(onChange).toHaveBeenCalledWith({
      tools: [...ALL_BUILTIN_TOOLS],
      mcps: [],
      skills: [],
    });
  });

  it('点击 [清空] → onChange 设置为空工具集', () => {
    const onChange = vi.fn();
    render(<CapabilityTabs {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByText('清空'));
    expect(onChange).toHaveBeenCalledWith({
      tools: [],
      mcps: [],
      skills: [],
    });
  });

  it('点击 [安全最小集] → onChange 重置为安全最小集', () => {
    const onChange = vi.fn();
    render(
      <CapabilityTabs
        {...defaultProps({
          value: { tools: ['bash'], mcps: [], skills: [] },
          onChange,
        })}
      />,
    );
    fireEvent.click(screen.getByText('安全最小集'));
    expect(onChange).toHaveBeenCalledWith({
      tools: [...SAFE_MINIMUM_TOOLS],
      mcps: [],
      skills: [],
    });
  });
});

describe('CapabilityTabs — readonly 模式（builtin configure）', () => {
  it('所有工具 checkbox disabled', () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'readonly',
          value: { tools: ['read_file'], mcps: [], skills: [] },
        })}
      />,
    );
    // 勾选的 disabled
    expect(screen.getByLabelText('read_file')).toBeDisabled();
    // 未勾选的也 disabled
    expect(screen.getByLabelText('bash')).toBeDisabled();
  });

  it('不渲染快捷按钮（全选/清空/安全最小集 都不出现）', () => {
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

  it('点击 disabled checkbox 不触发 onChange', () => {
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
    const cb = screen.getByLabelText('bash') as HTMLInputElement;
    expect(cb).toBeDisabled();
    expect(cb.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('CapabilityTabs — override 模式（Layer 3 弹窗）', () => {
  it('checkbox 反映 value 最终值（非 defaultValue）', () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'override',
          defaultValue: { tools: ['read_file'], mcps: [], skills: [] },
          value: { tools: ['read_file', 'bash'], mcps: [], skills: [] },
        })}
      />,
    );
    expect((screen.getByLabelText('read_file') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('bash') as HTMLInputElement).checked).toBe(true);
    // grep 既不在 default 也不在 value → 未勾
    expect((screen.getByLabelText('grep') as HTMLInputElement).checked).toBe(false);
  });

  it('checkbox 可交互（不 disabled）', () => {
    render(
      <CapabilityTabs
        {...defaultProps({
          mode: 'override',
          defaultValue: { tools: ['read_file'], mcps: [], skills: [] },
          value: { tools: ['read_file'], mcps: [], skills: [] },
        })}
      />,
    );
    expect(screen.getByLabelText('bash')).not.toBeDisabled();
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
          defaultValue: { tools: ['read_file', 'grep'], mcps: [], skills: [] },
          value: { tools: ['read_file'], mcps: [], skills: [] },
        })}
      />,
    );
    // 提示里应列出默认工具
    expect(screen.getByText(/read_file.*grep|grep.*read_file/)).toBeInTheDocument();
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
      tools: [...SAFE_MINIMUM_TOOLS],
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
      tools: [...SAFE_MINIMUM_TOOLS],
      mcps: [],
      skills: ['debugging'],
    });
  });
});
