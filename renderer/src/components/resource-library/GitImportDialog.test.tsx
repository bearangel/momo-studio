// renderer/src/components/resource-library/GitImportDialog.test.tsx
//
// Git 仓库 skill 两阶段导入弹窗测试（spec §5 / P2.6 Task 3）：
//   - input：URL 前端校验（https + github/gitlab host），非法 → 「扫描」disabled + 提示；
//     扫描进行中按钮转「扫描中…」并 disabled（下载耗时可观）
//   - review：skills 列表（名称+描述+slug）+ 同名覆盖警示（list 查 slug 交集）
//   - scan reject（未发现 / 私有 / 网络）→ 红字 role=alert，回 input 可改
//   - 确认导入 → importGitRepoSkills(importId) 入参正确；全成功 → installNotice
//     横幅「导入成功 N 条技能」+ onSuccess + onClose（P2.5 D3 模式）
//   - 部分失败 → 留窗展示成功数 + 失败明细；imported>0 时 onSuccess
//   - import reject → 红字留窗
//
// Mock 策略与 McpJsonPasteDialog.test.tsx 同形态：不 vi.mock 模块，在真实
// jsdom window 上装 window.api 属性（resource.scanGitRepoSkills /
// importGitRepoSkills / list 三个通道），ipc.client 走真通道（Proxy）经桩。
// useResourceStore 用真实 store（弹窗直写横幅；beforeEach 重置防跨用例污染）。
// vitest globals:false，显式导入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GitImportDialog } from './GitImportDialog';
import { useResourceStore } from '../../stores/resource.store';
import type { ResourceItem, ScannedSkill } from '../../ipc/types';

// ---- mock IPC 桩（弹窗只触达 resource 三个通道）----
const resourceScan = vi.fn();
const resourceImport = vi.fn();
const resourceList = vi.fn();

const mockApi = {
  resource: { scanGitRepoSkills: resourceScan, importGitRepoSkills: resourceImport, list: resourceList },
};

// ---- 测试载荷 ----
const REPO_URL = 'https://github.com/obra/superpowers';

const SCAN_SKILLS: ScannedSkill[] = [
  { slug: 'brainstorming', name: '头脑风暴', description: '创造性工作前探索意图' },
  { slug: 'whodunit', name: '侦探', description: '系统性排查根因' },
];
const SCAN_RESULT = { importId: 'git-import-uuid-1', skills: SCAN_SKILLS };

// 同名冲突预检用 installed skill item（slug = 'brainstorming'）
const INSTALLED_BRAINSTORMING: ResourceItem = {
  id: 'custom-skill-brainstorming',
  type: 'skill',
  source: 'custom',
  slug: 'brainstorming',
  name: '头脑风暴',
  description: '',
  installed: true,
  installable: false,
  removable: true,
};

// import 全成功结果（imported 与扫描清单同构）
const IMPORT_ALL_OK = {
  imported: SCAN_SKILLS.map((s) => ({ slug: s.slug, name: s.name, description: s.description })),
  failures: [] as Array<{ slug: string; reason: string }>,
};

/** 便捷：渲染 + 填 URL + 点「扫描」直达 review 阶段（onSuccess/onClose 可注入断言桩） */
async function renderToReview(props: { onClose?: () => void; onSuccess?: () => void } = {}): Promise<void> {
  render(<GitImportDialog onClose={props.onClose ?? vi.fn()} onSuccess={props.onSuccess ?? vi.fn()} />);
  fireEvent.change(screen.getByLabelText('仓库地址'), { target: { value: REPO_URL } });
  fireEvent.click(screen.getByRole('button', { name: '扫描' }));
  await screen.findByText('待导入 2 条：');
}

beforeEach(() => {
  resourceScan.mockReset().mockResolvedValue(SCAN_RESULT);
  resourceImport.mockReset().mockResolvedValue(IMPORT_ALL_OK);
  resourceList.mockReset().mockResolvedValue([] as ResourceItem[]);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  // 横幅是 store 单例状态，逐用例重置（防止上一用例的 installNotice 污染断言）
  useResourceStore.setState({ installNotice: null });
});

describe('GitImportDialog', () => {
  it('URL 校验：空 / 非 https / 非法 host → 「扫描」disabled + 提示；合法 URL 恢复可用', () => {
    render(<GitImportDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    const scanBtn = () => screen.getByRole('button', { name: '扫描' }) as HTMLButtonElement;
    // 空输入：disabled，无提示文案
    expect(scanBtn().disabled).toBe(true);
    expect(screen.queryByText(/仅支持 GitHub \/ GitLab/)).toBeNull();
    // 非 https
    fireEvent.change(screen.getByLabelText('仓库地址'), { target: { value: 'http://github.com/obra/superpowers' } });
    expect(scanBtn().disabled).toBe(true);
    expect(screen.getByText(/仅支持 GitHub \/ GitLab/)).toBeTruthy();
    // https 但 host 不在白名单
    fireEvent.change(screen.getByLabelText('仓库地址'), { target: { value: 'https://bitbucket.org/obra/superpowers' } });
    expect(scanBtn().disabled).toBe(true);
    // 合法 URL 恢复
    fireEvent.change(screen.getByLabelText('仓库地址'), { target: { value: REPO_URL } });
    expect(scanBtn().disabled).toBe(false);
  });

  it('扫描中按钮转「扫描中…」并 disabled（下载耗时可观）', async () => {
    // 挂起 promise：点击后停留在扫描态
    resourceScan.mockReturnValueOnce(new Promise(() => {}));
    render(<GitImportDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('仓库地址'), { target: { value: REPO_URL } });
    fireEvent.click(screen.getByRole('button', { name: '扫描' }));
    const scanning = await screen.findByRole('button', { name: '扫描中…' });
    expect((scanning as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '扫描' })).toBeNull();
  });

  it('扫描成功 → review 列表渲染（名称/描述/slug）+ 同名警示（list 查 slug 交集）', async () => {
    resourceList.mockResolvedValueOnce([INSTALLED_BRAINSTORMING]);
    await renderToReview();
    // 列表三项信息齐全
    expect(screen.getByText('头脑风暴')).toBeTruthy();
    expect(screen.getByText('创造性工作前探索意图')).toBeTruthy();
    expect(screen.getByText('brainstorming')).toBeTruthy();
    expect(screen.getByText('侦探')).toBeTruthy();
    expect(screen.getByText('whodunit')).toBeTruthy();
    // 同名预检走 skill 页清单（type 收窄）
    expect(resourceList).toHaveBeenCalledWith({ type: 'skill' });
    // 冲突警示
    expect(screen.getByText(/将覆盖 1 个同名技能：brainstorming/)).toBeTruthy();
    // 底部按钮：「返回修改」+「确认导入 2 条」
    expect(screen.getByRole('button', { name: '返回修改' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认导入 2 条' })).toBeTruthy();
  });

  it('scan reject（未发现 / 私有 / 网络）→ 红字 role=alert + 回 input 可改', async () => {
    resourceScan.mockRejectedValueOnce(new Error('未发现 SKILL.md（要求仓库内含 SKILL.md 文件）'));
    render(<GitImportDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('仓库地址'), { target: { value: REPO_URL } });
    fireEvent.click(screen.getByRole('button', { name: '扫描' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('未发现 SKILL.md');
    // 留在 input 阶段：输入框与「扫描」按钮仍在，可修改后重试
    const input = screen.getByLabelText('仓库地址') as HTMLInputElement;
    expect(input.value).toBe(REPO_URL);
    fireEvent.change(input, { target: { value: 'https://gitlab.com/obra/skills' } });
    expect(input.value).toBe('https://gitlab.com/obra/skills');
    expect((screen.getByRole('button', { name: '扫描' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('确认导入 → importGitRepoSkills(importId) 入参正确；全成功 → 横幅 + onSuccess + onClose', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<GitImportDialog onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('仓库地址'), { target: { value: REPO_URL } });
    fireEvent.click(screen.getByRole('button', { name: '扫描' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入 2 条' }));
    // 两阶段接力：importId 来自 scan 返回（跨模块 ID 单点透传）
    await waitFor(() => expect(resourceImport).toHaveBeenCalledWith('git-import-uuid-1'));
    // P2.5 D3：全成功 → 横幅 + 自动关
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(useResourceStore.getState().installNotice).toBe('导入成功 2 条技能');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('部分失败（failures 非空）→ 留窗展示成功数 + 失败明细；imported>0 触发 onSuccess', async () => {
    resourceImport.mockResolvedValueOnce({
      imported: [{ slug: 'brainstorming', name: '头脑风暴', description: '' }],
      failures: [{ slug: 'whodunit', reason: '路径包含非法段' }],
    });
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    await renderToReview({ onClose, onSuccess });
    fireEvent.click(screen.getByRole('button', { name: '确认导入 2 条' }));
    expect(await screen.findByText('成功 1 条')).toBeTruthy();
    // 失败明细逐条（slug：reason）
    expect(screen.getByText('whodunit：路径包含非法段')).toBeTruthy();
    // 留窗：不自动关、不横幅（等用户看完明细手动关闭）
    expect(onClose).not.toHaveBeenCalled();
    expect(useResourceStore.getState().installNotice).toBeNull();
    // 1 条成功 → onSuccess 已触发（父级刷新可见部分结果）
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // 手动关闭可用
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
  });

  it('import reject → 红字留窗（不自动关）', async () => {
    resourceImport.mockRejectedValueOnce(new Error('导入会话已失效，请重新扫描'));
    const onClose = vi.fn();
    await renderToReview({ onClose });
    fireEvent.click(screen.getByRole('button', { name: '确认导入 2 条' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('导入会话已失效');
    expect(onClose).not.toHaveBeenCalled();
  });
});
