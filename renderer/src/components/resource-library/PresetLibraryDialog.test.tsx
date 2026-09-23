// renderer/src/components/resource-library/PresetLibraryDialog.test.tsx
// PresetLibraryDialog 行为（P2.3 spec §5/§7）：
//   ① 挂载拉 resource:listBuiltinPresets(type)，列表渲染 4 个预置（名/描述/emoji）
//   ② 点「选择」→ onSelect(slug) + onClose（自关契约——父层关弹窗与自关幂等叠加）
//   ③ 空清单（mcp/skill 类型面）→ 空态「该类型暂无预置」
//   ④ 拉取失败 → 红字（role=alert + text-status-error）+「重试」后恢复列表
//   ⑤ 加载中 → 「加载中…」文案（resolve 前可见）
// Mock 方式遵循 ExternalMarketplacePopover.test.tsx（Task 3）先例：真实 jsdom
// window 上装 window.api 属性——ipc.client 是真实 Proxy 走桩（momo-test-rules：
// mock 收窄到 IPC 边界，业务逻辑用真实实现）。
// fixture 对齐 electron/resources/agents/*.yaml 真实元数据（4 个预置）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PresetLibraryDialog } from './PresetLibraryDialog';
import type { BuiltinPresetItem, ResourceType } from '../../ipc/types';

// window.api 属性安装（只装组件触达的 resource 命名空间）
const listBuiltinPresetsMock = vi.fn<[ResourceType], Promise<BuiltinPresetItem[]>>();

const mockApi = {
  resource: {
    listBuiltinPresets: listBuiltinPresetsMock,
  },
};

/** 预置 fixture——与 electron/resources/agents/ 四个 YAML 元数据对齐 */
const PRESETS_FIXTURE: BuiltinPresetItem[] = [
  { slug: 'coder', name: '程序员', description: '根据需求实现代码，支持多种编程语言', iconEmoji: '💻' },
  { slug: 'pm-agent', name: '项目经理', description: '协调全流程：需求→设计→编码。调度子 agent 完成任务。', iconEmoji: '👔' },
  { slug: 'requirement-analyst', name: '需求讨论师', description: '帮用户梳理需求、产出结构化需求文档', iconEmoji: '📝' },
  { slug: 'office-assistant', name: '办公助理', description: '处理日常办公文档——Excel 运算汇总、Word/PPT 撰写、PDF 生成与内容提取。', iconEmoji: '💼' },
];

const onSelect = vi.fn<[string], void>();
const onClose = vi.fn<[], void>();

const renderDialog = (type: ResourceType = 'agent'): void => {
  render(<PresetLibraryDialog type={type} onSelect={onSelect} onClose={onClose} />);
};

beforeEach(() => {
  listBuiltinPresetsMock.mockReset();
  // 默认 4 预置（happy path 基线）；空态/失败路径在用例内覆盖
  listBuiltinPresetsMock.mockResolvedValue(PRESETS_FIXTURE);
  onSelect.mockClear();
  onClose.mockClear();
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('PresetLibraryDialog - ① 挂载拉清单并渲染', () => {
  it('挂载即调 listBuiltinPresets("agent")，弹窗标题「启用预置库」', async () => {
    renderDialog('agent');
    await waitFor(() => expect(listBuiltinPresetsMock).toHaveBeenCalledWith('agent'));
    expect(screen.getByRole('dialog', { name: '启用预置库' })).toBeTruthy();
  });

  it('渲染 4 个预置行（名称 / 描述 / iconEmoji 数据展示）', async () => {
    renderDialog('agent');
    await screen.findByText('程序员');
    expect(screen.getByText('项目经理')).toBeTruthy();
    expect(screen.getByText('需求讨论师')).toBeTruthy();
    expect(screen.getByText('办公助理')).toBeTruthy();
    // 描述与 iconEmoji（数据原样渲染，非 UI 图标）
    expect(screen.getByText('根据需求实现代码，支持多种编程语言')).toBeTruthy();
    expect(screen.getByText('💻')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '选择' })).toHaveLength(4);
  });
});

describe('PresetLibraryDialog - ② 选中契约', () => {
  it('点「选择」→ onSelect(slug) + onClose', async () => {
    renderDialog('agent');
    await screen.findByText('程序员');
    fireEvent.click(screen.getAllByRole('button', { name: '选择' })[0]!);
    expect(onSelect).toHaveBeenCalledWith('coder');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('PresetLibraryDialog - ③ 空态', () => {
  it('空清单 → 「该类型暂无预置」（mcp/skill 类型面）', async () => {
    listBuiltinPresetsMock.mockResolvedValueOnce([]);
    renderDialog('mcp');
    await waitFor(() => expect(listBuiltinPresetsMock).toHaveBeenCalledWith('mcp'));
    expect(await screen.findByText('该类型暂无预置')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '选择' })).toBeNull();
  });
});

describe('PresetLibraryDialog - ④ 失败红字 + 重试', () => {
  it('reject → 红字（role=alert + text-status-error）含错误详情；重试后恢复列表', async () => {
    listBuiltinPresetsMock.mockRejectedValueOnce(new Error('YAML 解析失败'));
    renderDialog('agent');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('预置清单读取失败');
    expect(alert.textContent).toContain('YAML 解析失败');
    // 红字 = 语义状态色 token（spec §7「弹窗内红字」）
    expect(alert.className).toContain('text-status-error');
    // 重试（mock 已恢复 resolved）→ 列表恢复、红字消失
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('程序员');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(listBuiltinPresetsMock).toHaveBeenCalledTimes(2);
  });
});

describe('PresetLibraryDialog - ⑤ 加载中文案', () => {
  it('resolve 前「加载中…」可见，resolve 后被列表替换', async () => {
    let resolveList: (v: BuiltinPresetItem[]) => void = () => undefined;
    listBuiltinPresetsMock.mockReturnValueOnce(
      new Promise<BuiltinPresetItem[]>((res) => {
        resolveList = res;
      }),
    );
    renderDialog('agent');
    expect(screen.getByText('加载中…')).toBeTruthy();
    resolveList([]);
    expect(await screen.findByText('该类型暂无预置')).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });
});
