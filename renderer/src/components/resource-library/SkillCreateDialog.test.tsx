// renderer/src/components/resource-library/SkillCreateDialog.test.tsx
//
// 表单创建 SKILL.md 弹窗测试（spec §4.3）：
//   - 必填缺失时提交按钮禁用
//   - 填齐后提交调 createSkill，传参精确 + 成功提示保留展示
//   - slug 与已装 skill 同名时显示覆盖警示文案
//   - 创建失败内联红字展示且弹窗不关
//
// Mock 策略遵循 McpJsonPasteDialog.test / ResourceLibraryView.test 的既有形态：
// 在真实 jsdom window 上装 window.api 属性，ipc.client 走真通道（Proxy）经桩。
// vitest globals:false，显式导入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillCreateDialog } from './SkillCreateDialog';
import type { ResourceItem, UploadedSkill } from '../../ipc/types';

// ---- mock IPC 桩（弹窗只触达 resource 两个通道）----
const resourceList = vi.fn();
const resourceCreateSkill = vi.fn();

const mockApi = {
  resource: { list: resourceList, createSkill: resourceCreateSkill },
};

// ---- 测试载荷 ----
// 模拟已装 skill 列表中含 slug='dup'——触发 willOverwrite 路径
const INSTALLED_DUP: ResourceItem = {
  id: 'custom-skill-dup',
  type: 'skill',
  source: 'custom',
  slug: 'dup',
  name: 'dup',
  description: '',
  installed: true,
  installable: false,
  removable: true,
};

// createSkill 成功返回（主进程 custom 映射形状，UploadedSkill）
const CREATED_NEW_ONE: UploadedSkill = {
  slug: 'new-one',
  name: 'New One',
  description: 'd',
};

// 复制 brief 的填表序列：fireEvent.change 三次输入
function fillForm(): void {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'New One' } });
  fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'd' } });
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '# 你好' } });
}

beforeEach(() => {
  resourceList.mockReset().mockResolvedValue([] as ResourceItem[]);
  resourceCreateSkill.mockReset().mockResolvedValue(CREATED_NEW_ONE);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('SkillCreateDialog', () => {
  it('必填缺失时提交禁用', () => {
    render(<SkillCreateDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
  });

  it('填齐后提交调 createSkill，传参精确且成功提示保留展示', async () => {
    render(<SkillCreateDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(resourceCreateSkill).toHaveBeenCalledWith({ name: 'New One', description: 'd', body: '# 你好' }),
    );
    expect(await screen.findByText(/已创建：new-one/)).toBeTruthy();
  });

  it('slug 与已装 skill 同名时显示覆盖警示文案', async () => {
    // 首拉返回含 slug='dup' → 填名称='dup' 触发 willOverwrite
    resourceList.mockResolvedValueOnce([INSTALLED_DUP]);
    render(<SkillCreateDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'd' } });
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: 'b' } });
    expect(await screen.findByText(/已存在同名 skill.*保存将覆盖/)).toBeTruthy();
  });

  it('创建失败内联红字展示且弹窗不关', async () => {
    resourceCreateSkill.mockRejectedValueOnce(new Error('写盘失败'));
    const onClose = vi.fn();
    render(<SkillCreateDialog onClose={onClose} onSuccess={vi.fn()} />);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('写盘失败')).toBeTruthy();
    // 失败时不关闭弹窗
    expect(onClose).not.toHaveBeenCalled();
  });
});