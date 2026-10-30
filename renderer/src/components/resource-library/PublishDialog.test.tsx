// renderer/src/components/resource-library/PublishDialog.test.tsx
// 发布到 momo-hub 对话框（M1 Task 14，P1 预览 task-14-preview.html 已批契约锁）：
//   - 表单态：元数据预填（name/version/description）+ hub 状态行（绿点/地址）+
//     类型徽章（accent，四类型一枚）+ 版本白名单 hint + 常驻说明行
//   - 进行态：表单锁定 + 双按钮禁用 + 「正在上传 v…」；Esc 不关弹窗（防半途撤销）
//   - 成功态：绿勾 + 已发布 v{version} + slug/体积回执摘要；关闭收束
//   - 失败态：红条人话错误（T13 rejection message 原文）+ 版本字段保留可改 +
//     重试 = 原表单态字段直提（不重置）
//   - IPC 契约：hub:publishResource 入参 {type, ref, meta}——ref 对齐 T13
//     buildPublishPackage（agent=定义 id / skill=slug / mcp=注册名 / plugin=插件 id）
// Mock 方式遵循 TypePageShell.test.tsx 既有形态：真实 jsdom window 上装 window.api
// 属性（mock 收窄到 IPC 边界）；hub 连接状态经 useHubStore.setState 直写。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PublishDialog } from './PublishDialog';
import { useHubStore } from '../../stores/hub.store';
import type { HubPublishResult, HubStatus, ResourceItem } from '../../ipc/types';

const publishResourceMock = vi.fn();

const mockApi = {
  hub: {
    publishResource: publishResourceMock,
  },
};

const ONLINE: HubStatus = {
  configured: true,
  state: 'online',
  hubUrl: 'http://192.168.1.8:8717',
  nodeName: '办公室 MacBook',
  nodeId: 'a3f9c2e1deadbeef',
  lastError: null,
  lastErrorCode: null,
  hubProtoVer: null,
};

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'custom-agent-def-123',
    type: 'agent',
    source: 'custom',
    slug: 'def-123',
    name: '代码评审员',
    description: '按仓库规范做增量代码评审，输出分级问题清单与修复建议',
    version: '1.2.0',
    installed: true,
    installable: false,
    removable: true,
    ...over,
  };
}

/** 受控 publish promise：进行态断言后手动 settle */
function controlledPublish(): { resolve: (r: HubPublishResult) => void; reject: (e: Error) => void } {
  let resolve!: (r: HubPublishResult) => void;
  let reject!: (e: Error) => void;
  publishResourceMock.mockImplementationOnce(
    () =>
      new Promise<HubPublishResult>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return { resolve: (r) => resolve(r), reject: (e) => reject(e) };
}

beforeEach(() => {
  publishResourceMock.mockReset().mockResolvedValue({
    slug: 'code-reviewer', version: '1.2.0', checksum: 'x', sizeBytes: 1024,
  });
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  useHubStore.setState({ status: ONLINE, nodes: [], loadError: null });
});

describe('PublishDialog · 表单态', () => {
  it('预填 name/version/description；hub 状态行（已连接 + 地址）；类型徽章；hint 与常驻说明行', () => {
    render(<PublishDialog item={mkItem({})} onClose={vi.fn()} />);
    expect(screen.getByText('发布到 momo-hub')).toBeTruthy();
    // hub 状态行：绿点徽章文案 + 地址（M0 HubSettingsPanel 同形态）
    expect(screen.getByText('已连接')).toBeTruthy();
    expect(screen.getByText('http://192.168.1.8:8717')).toBeTruthy();
    // 元数据预填（name/version/description 均可改）
    expect(screen.getByLabelText('名称')).toHaveValue('代码评审员');
    expect(screen.getByLabelText('版本')).toHaveValue('1.2.0');
    expect(screen.getByLabelText('描述')).toHaveValue('按仓库规范做增量代码评审，输出分级问题清单与修复建议');
    // 版本白名单 hint + 标签 hint（hub 契约文案）
    expect(screen.getByText('仅数字 / 字母 / 点 / 加减号（hub 白名单）')).toBeTruthy();
    expect(screen.getByText('多个标签用英文逗号分隔')).toBeTruthy();
    // 类型徽章：随资源类型渲染一枚（accent tone）
    expect(screen.getByText('agent')).toBeTruthy();
    // 常驻说明行
    expect(screen.getByText('发布后，组内所有节点可在资源库「hub」页签安装此资源。')).toBeTruthy();
    // footer：左 ghost 取消 → 右 primary 发布（TeamDialog 先例次序）
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布' })).toBeTruthy();
  });

  it('version 缺失时预填 1.0.0（custom skill frontmatter 版本优先于兜底）', () => {
    render(
      <PublishDialog
        item={mkItem({
          id: 'custom-skill-md-notes',
          type: 'skill',
          slug: 'md-notes',
          version: undefined,
          custom: { installedAt: '2026-01-01', skillFrontmatter: { name: 'md-notes', version: '0.3.2' } },
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('版本')).toHaveValue('0.3.2');
  });

  it('版本白名单不通过（含空格）时发布按钮禁用', () => {
    render(<PublishDialog item={mkItem({})} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('版本'), { target: { value: '1.0 beta' } });
    expect(screen.getByRole('button', { name: '发布' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('版本'), { target: { value: '1.0.0-beta.1' } });
    expect(screen.getByRole('button', { name: '发布' }).hasAttribute('disabled')).toBe(false);
  });

  it('表单态 Esc 关闭弹窗（Dialog 原子件默认行为）', () => {
    const onClose = vi.fn();
    render(<PublishDialog item={mkItem({})} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('PublishDialog · 提交 IPC 契约（ref 对齐 T13 buildPublishPackage）', () => {
  it('agent：ref = 定义 id（custom 资源 slug 即 def.id）；tags 逗号解析 + category 选择', async () => {
    render(<PublishDialog item={mkItem({})} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '代码评审, 质量守卫,,git' } });
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '效率' } });
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(publishResourceMock).toHaveBeenCalledTimes(1));
    expect(publishResourceMock).toHaveBeenCalledWith({
      type: 'agent',
      ref: 'def-123',
      meta: {
        name: '代码评审员',
        version: '1.2.0',
        description: '按仓库规范做增量代码评审，输出分级问题清单与修复建议',
        tags: ['代码评审', '质量守卫', 'git'],
        category: '效率',
      },
    });
  });

  it('skill：ref = slug；mcp：ref = 注册名；plugin：ref = 插件域 id（非资源 id）', async () => {
    const cases: Array<{ item: ResourceItem; ref: string }> = [
      [
        mkItem({ id: 'custom-skill-md', type: 'skill', slug: 'md-notes', name: '纪要' }),
        'md-notes',
      ],
      [
        mkItem({ id: 'custom-mcp-wiki', type: 'mcp', slug: 'wiki-search', name: '维基搜索' }),
        'wiki-search',
      ],
      [
        mkItem({
          id: 'custom-plugin-cg',
          type: 'plugin',
          slug: 'cg',
          name: '代码卫士',
          plugin: { id: 'cg', state: 'active', devSource: false, sourcePath: null, components: [], enabled: true },
        }),
        'cg',
      ],
    ].map(([item, ref]) => ({ item: item as ResourceItem, ref: ref as string }));
    for (const { item, ref } of cases) {
      publishResourceMock.mockResolvedValueOnce({
        slug: item.slug, version: '1.0.0', checksum: 'x', sizeBytes: 1024,
      });
      const { unmount } = render(<PublishDialog item={item} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '发布' }));
      await waitFor(() => expect(publishResourceMock).toHaveBeenCalled());
      expect(publishResourceMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: item.type, ref }),
      );
      unmount();
      publishResourceMock.mockClear();
    }
  });

  it('marketplace 源 skill：ref = slug（M2.2 Task 2 开放源——载荷与 custom skill 同形，版本预填 catalog 元数据）', async () => {
    render(
      <PublishDialog
        item={mkItem({
          id: 'marketplace-skill-superpowers-brainstorm', type: 'skill', source: 'marketplace',
          slug: 'superpowers-brainstorm', name: '头脑风暴', version: '1.4.0',
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('版本')).toHaveValue('1.4.0');
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(publishResourceMock).toHaveBeenCalledTimes(1));
    expect(publishResourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'skill', ref: 'superpowers-brainstorm' }),
    );
  });
});

describe('PublishDialog · 进行态 / 成功态 / 失败态', () => {
  it('进行态：表单锁定 + 取消/发布禁用 + 「正在上传 v1.2.0…」；Esc 不关弹窗', async () => {
    const onClose = vi.fn();
    const ctl = controlledPublish();
    render(<PublishDialog item={mkItem({})} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(publishResourceMock).toHaveBeenCalled());
    // 进度行：主文案 + 打包传输副行（hub 地址）
    expect(screen.getByText('正在上传 v1.2.0…')).toBeTruthy();
    expect(screen.getByText('打包并传输到 http://192.168.1.8:8717')).toBeTruthy();
    // 表单锁定（disabled）
    expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('版本') as HTMLInputElement).disabled).toBe(true);
    // 双按钮禁用（防半途撤销）
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '发布' }).hasAttribute('disabled')).toBe(true);
    // Esc 拦截：不关弹窗（预览 notes 交互要点 5）
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('发布到 momo-hub')).toBeTruthy();
    ctl.resolve({ slug: 'code-reviewer', version: '1.2.0', checksum: 'x', sizeBytes: 1 });
  });

  it('成功态：绿勾 + 已发布 v1.2.0 + slug/体积回执摘要；关闭收束', async () => {
    const onClose = vi.fn();
    const ctl = controlledPublish();
    render(<PublishDialog item={mkItem({})} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    ctl.resolve({ slug: 'code-reviewer', version: '1.2.0', checksum: 'abc', sizeBytes: 2516582 });
    await waitFor(() => expect(screen.getByText('已发布 v1.2.0')).toBeTruthy());
    // 回执摘要：slug · 体积（MB 一位小数）· 引导语
    expect(screen.getByText('code-reviewer · 2.4 MB · 组内节点已可在「hub」页签安装')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('失败态：红条人话错误 + 版本字段保留可改 + 重试原字段直提（不重置）', async () => {
    const ctl = controlledPublish();
    render(<PublishDialog item={mkItem({})} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    ctl.reject(new Error('hub 上已有 code-reviewer@1.2.0——该版本已存在'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // 人话错误原文（T13 rejection message 直出，不加码翻译）
    expect(screen.getByText('发布失败：hub 上已有 code-reviewer@1.2.0——该版本已存在')).toBeTruthy();
    // 版本字段保留可改 + 重试 hint
    expect(screen.getByText('重试前可在此直接改版本号')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('版本'), { target: { value: '1.2.1' } });
    // 重试 = 原表单态字段直提（name 等不重置）
    publishResourceMock.mockResolvedValueOnce({ slug: 'code-reviewer', version: '1.2.1', checksum: 'y', sizeBytes: 2048 });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(publishResourceMock).toHaveBeenCalledTimes(2));
    expect(publishResourceMock).toHaveBeenLastCalledWith({
      type: 'agent',
      ref: 'def-123',
      meta: expect.objectContaining({ name: '代码评审员', version: '1.2.1' }),
    });
  });

  it('hub 状态行随连接态切换：connecting → 黄点「连接中」', () => {
    useHubStore.setState({
      status: { ...ONLINE, state: 'connecting', lastError: '连接超时' },
    });
    render(<PublishDialog item={mkItem({})} onClose={vi.fn()} />);
    expect(screen.getByText('连接中')).toBeTruthy();
    expect(screen.queryByText('已连接')).toBeNull();
  });
});

// ── M5.1 §1.2：版本回写回执（成功态内警示行——失败不推翻发布）──
describe('PublishDialog · 版本回写回执（M5.1）', () => {
  it('回写失败 → 成功态仍收束 + 警示行「发布成功但版本回写失败：{原因}」', async () => {
    const ctl = controlledPublish();
    render(<PublishDialog item={mkItem({})} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    ctl.resolve({
      slug: 'code-reviewer', version: '1.2.0', checksum: 'abc', sizeBytes: 2048,
      versionWriteback: { written: false, error: 'SKILL.md 只读' },
    });
    await waitFor(() => expect(screen.getByText('已发布 v1.2.0')).toBeTruthy());
    expect(screen.getByTestId('writeback-notice').textContent).toBe('发布成功但版本回写失败：SKILL.md 只读');
  });

  it('plugin zip 装源 skipped → 提示「插件本体由插件包管理，版本未回写」', async () => {
    const ctl = controlledPublish();
    render(<PublishDialog item={mkItem({})} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    ctl.resolve({
      slug: 'code-reviewer', version: '1.2.0', checksum: 'abc', sizeBytes: 2048,
      versionWriteback: { written: false, skipped: true, notice: '插件本体由插件包管理，版本未回写' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('writeback-notice').textContent).toBe('插件本体由插件包管理，版本未回写'),
    );
  });

  it('回写成功 / 旧回执无 versionWriteback 段 → 无警示行（既有语义零变化）', async () => {
    const ctl = controlledPublish();
    render(<PublishDialog item={mkItem({})} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    ctl.resolve({
      slug: 'code-reviewer', version: '1.2.0', checksum: 'abc', sizeBytes: 2048,
      versionWriteback: { written: true },
    });
    await waitFor(() => expect(screen.getByText('已发布 v1.2.0')).toBeTruthy());
    expect(screen.queryByTestId('writeback-notice')).toBeNull();
  });
});
