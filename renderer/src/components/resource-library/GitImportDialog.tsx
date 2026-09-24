// renderer/src/components/resource-library/GitImportDialog.tsx
// Git 仓库 skill 两阶段导入（spec §5 / P2.6）：扫描（下载+解析）→ 预览
// （列表+同名覆盖警示）→ 确认导入 → 结果。阶段机照 McpJsonPasteDialog。
//   - input：前端 URL 预校验（https + github/gitlab host，与 electron 端
//     buildArchiveUrl 白名单同口径）→ 非法「扫描」disabled + 提示；扫描进行中
//     按钮转「扫描中…」（整仓 zip 下载耗时可观）
//   - review：list({type:'skill'}) 查 slug 交集 →「将覆盖 N 个同名技能」（覆盖
//     语义须显式确认）；importId 自 scan 返回单点透传给 import（electron 端
//     Map 一次性消费）
//   - 全成功 → 直写 installNotice 横幅 + 自动关（P2.5 D3 模式）；部分失败 →
//     留窗逐条明细（不横幅化，等用户手动处理）；import reject → 红字回 review
//     （数据保留，可「返回修改」重扫）
import { useState } from 'react';
import { ipc } from '../../ipc/client';
import type { ScannedSkill } from '../../ipc/types';
import { useResourceStore } from '../../stores/resource.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

interface Props {
  onClose: () => void;
  /** 导入处理完毕且至少一条成功后调用——父组件刷新列表 */
  onSuccess: () => void;
}

type Phase =
  | { kind: 'input' }
  | { kind: 'review'; importId: string; skills: ScannedSkill[]; conflicts: string[] }
  | { kind: 'importing' }
  | { kind: 'done'; ok: number; failures: Array<{ slug: string; reason: string }> };

/** 前端 URL 预校验：https + github/gitlab（含 www）+ owner/repo 至少两段 */
const REPO_URL_RE = /^https:\/\/(www\.)?(github|gitlab)\.com\/[\w.-]+\/[\w.-]+/;

export function GitImportDialog({ onClose, onSuccess }: Props) {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  // 扫描是 input 阶段的按钮子态（非独立阶段——无独立 UI 分支）
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 提示只在「输过但非法」时出现（空输入只 disable 不催促）
  const urlInvalid = url.trim() !== '' && !REPO_URL_RE.test(url.trim());

  const handleScan = async (): Promise<void> => {
    setError(null);
    setScanning(true);
    try {
      const { importId, skills } = await ipc.resource.scanGitRepoSkills(url.trim());
      const installed = await ipc.resource.list({ type: 'skill' });
      const slugs = new Set(installed.map((i) => i.slug));
      const conflicts = skills.map((s) => s.slug).filter((s) => slugs.has(s));
      setPhase({ kind: 'review', importId, skills, conflicts });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const handleImport = async (): Promise<void> => {
    if (phase.kind !== 'review') return;
    // 闭包快照：import reject 时恢复 review 数据（重导入会话已失效，但仍可
    // 「返回修改」重新扫描；不留死窗）
    const review = phase;
    setError(null);
    setPhase({ kind: 'importing' });
    try {
      const { imported, failures } = await ipc.resource.importGitRepoSkills(review.importId);
      // 全成功 → 横幅 + 自动关（弹窗内直写 store，与 McpJsonPasteDialog 同模式）。
      // electron 端空清单不走此返回（scan 阶段已拒），failures 空即 imported ≥ 1。
      if (failures.length === 0) {
        useResourceStore.setState({ installNotice: `导入成功 ${imported.length} 条技能` });
        onSuccess();
        onClose();
        return;
      }
      setPhase({ kind: 'done', ok: imported.length, failures });
      if (imported.length > 0) onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase(review);
    }
  };

  return (
    // 容器 ariaLabel 与标题区分（避免与 skill 页其它弹窗 getByRole 撞名）
    <Dialog open onClose={onClose} title="从 Git 仓库导入" ariaLabel="从 Git 仓库导入技能" width={560}>
      <div className="flex flex-col gap-3">
        {phase.kind === 'input' && (
          <>
            <Input
              label="仓库地址"
              placeholder="https://github.com/obra/superpowers"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {urlInvalid && (
              <div className="text-xs text-status-warning">
                仅支持 GitHub / GitLab 仓库地址（https:// 开头，如 https://github.com/user/repo）
              </div>
            )}
            {error && <div role="alert" className="text-sm text-status-error break-all">{error}</div>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
              <Button
                type="button"
                disabled={!REPO_URL_RE.test(url.trim()) || scanning}
                onClick={() => void handleScan()}
              >
                {scanning ? '扫描中…' : '扫描'}
              </Button>
            </div>
          </>
        )}

        {phase.kind === 'review' && (
          <>
            {error && <div role="alert" className="text-sm text-status-error break-all">{error}</div>}
            <div className="text-sm text-secondary">待导入 {phase.skills.length} 条：</div>
            <ul className="max-h-52 overflow-y-auto flex flex-col gap-1">
              {phase.skills.map((s) => (
                <li key={s.slug} className="bg-surface-2 rounded-md px-2.5 py-1.5 flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-medium text-primary">{s.name}</span>
                    <code className="text-xs text-tertiary">{s.slug}</code>
                  </span>
                  {s.description && <span className="text-xs text-tertiary truncate">{s.description}</span>}
                </li>
              ))}
            </ul>
            {phase.conflicts.length > 0 && (
              <div className="text-xs text-status-warning">
                将覆盖 {phase.conflicts.length} 个同名技能：{phase.conflicts.join('、')}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={() => { setError(null); setPhase({ kind: 'input' }); }}>
                返回修改
              </Button>
              <Button type="button" onClick={() => void handleImport()}>确认导入 {phase.skills.length} 条</Button>
            </div>
          </>
        )}

        {phase.kind === 'importing' && <div className="text-sm text-tertiary py-4 text-center">导入中…</div>}

        {phase.kind === 'done' && (
          <>
            <div className="text-sm text-status-success">成功 {phase.ok} 条</div>
            <div className="flex flex-col gap-1">
              <div className="text-sm text-status-error">失败 {phase.failures.length} 条：</div>
              {phase.failures.map((f) => (
                <div key={f.slug} className="text-xs text-status-error break-all">{f.slug}：{f.reason}</div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" onClick={onClose}>关闭</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
