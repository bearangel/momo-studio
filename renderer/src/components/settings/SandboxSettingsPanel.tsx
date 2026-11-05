// renderer/src/components/settings/SandboxSettingsPanel.tsx
//
// v2.4 安全沙箱设置（spec §6.4）：沙箱模式 / 沙箱内网络出站 / 探测状态只读区。
// 状态与重探测走 ipc.sandbox（Task 7）；设置保存走 ipc.settings.updateGlobal。
// 2026-09-13 修订 B：网络出站三态收敛双态（永久允许（默认）/ 拒绝）——
// ask 信任卡机制已下线，垂直单选列表 + 行内说明保持既有形态。
// 2026-10-03 §8：新增「已授权目录」小节（工作空间持久授权列表 + 逐条撤销）。
// 2026-10-04：v2.5 工具链区块（目录写入双态 + 预置清单 textarea）随机制整体
// 移除——硬门控授权卡按实际被拦目录授权，预置机制无存在必要。
// 全语义 token；lucide ShieldCheck 图标由 SettingsNav 持有。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { SandboxInfo, SandboxMode, NetworkPolicy, SandboxWritePolicy } from '../../ipc/types';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';

const NETWORK_POLICY_OPTIONS: readonly { value: NetworkPolicy; label: string; hint: string }[] = [
  { value: 'allow', label: '允许联网（默认）', hint: 'Agent 执行命令时可正常访问网络' },
  { value: 'deny', label: '禁止联网', hint: '命令一律不能访问网络；与 AI 模型的对话不受影响' },
];

interface WorkspaceGrantEntry {
  workspaceId: string;
  dirs: string[];
}

export function SandboxSettingsPanel() {
  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // 已授权目录（spec 2026-10-03 §8）：工作空间持久授权列表，删除走 revokeWrite
  const [grants, setGrants] = useState<WorkspaceGrantEntry[]>([]);
  // 待撤销确认项（2026-10-04）：撤销是破坏性操作（该目录写入重新被拦）——红色按钮 + 二次确认
  const [pendingRevoke, setPendingRevoke] = useState<{ entry: WorkspaceGrantEntry; dir: string } | null>(null);
  // 全盘可写待确认（2026-11-05 spec §5.7）：开启是放大写域的危险操作——先弹确认
  const [confirmFullDisk, setConfirmFullDisk] = useState(false);

  useEffect(() => {
    void ipc.sandbox.getState().then(setInfo);
    void ipc.sandbox.listWriteGrants().then(setGrants).catch(() => {});
  }, []);

  // 乐观更新：本地先改 UI，保存 fire-and-forget（与全局设置单一真相源弱一致）
  const save = (patch: {
    sandboxMode?: SandboxMode;
    sandboxNetworkPolicy?: NetworkPolicy;
    sandboxWritePolicy?: SandboxWritePolicy;
  }): void => {
    if (!info) return;
    setInfo({
      ...info,
      settings: {
        mode: patch.sandboxMode ?? info.settings.mode,
        networkPolicy: patch.sandboxNetworkPolicy ?? info.settings.networkPolicy,
        writePolicy: patch.sandboxWritePolicy ?? info.settings.writePolicy,
      },
    });
    // IPC 拒绝不冒泡 unhandled rejection（乐观 UI 弱一致，下次拉取自然校正）
    void ipc.settings.updateGlobal(patch).catch(() => {});
  };

  // 逐条撤销（spec §8 可撤销红线）：本地乐观移除 + revokeWrite；失败静默（下次挂载重拉）
  const revokeGrant = (entry: WorkspaceGrantEntry, dir: string): void => {
    setGrants((prev) =>
      prev
        .map((g) => (g.workspaceId === entry.workspaceId ? { ...g, dirs: g.dirs.filter((d) => d !== dir) } : g))
        .filter((g) => g.dirs.length > 0),
    );
    void ipc.sandbox.revokeWrite({ scope: 'workspace', key: entry.workspaceId, dir }).catch(() => {});
  };

  const reprobe = async (): Promise<void> => {
    setBusy(true);
    try {
      setInfo(await ipc.sandbox.reprobe());
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="p-4 text-secondary text-sm">加载中...</div>;

  const st = info.state;
  const isWin = st?.platform === 'win32';
  const statusText =
    st === null
      ? '尚未检测'
      : st.available
        ? `已启用 · ${st.toolVersion ?? st.sandboxTool}`
        : st.platform === 'win32'
          ? 'Windows：无系统级防护'
          : `暂不可用：${st.unavailableReason ?? '未知'}`;

  return (
    <section className="flex flex-col gap-6" aria-label="安全沙箱设置">
      <div>
        <h2 className="text-base text-primary mb-1">安全沙箱</h2>
        <p className="text-sm text-secondary">
          控制 Agent 在电脑上执行命令时的权限边界：能改哪些文件、能否联网。
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">防护级别</legend>
        {(['strict', 'permissive'] as const).map((m) => (
          <label key={m} className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="radio"
              name="sandbox-mode"
              checked={info.settings.mode === m}
              onChange={() => save({ sandboxMode: m })}
              className="mt-1"
            />
            <span>
              {m === 'strict'
                ? '严格（推荐）——电脑缺少防护组件时，Agent 的命令将直接拒绝执行，绝不在无防护状态下运行'
                : '宽松——缺少防护组件时命令照常运行（此时没有额外防护，会做记录标记）'}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">联网权限</legend>
        {NETWORK_POLICY_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="radio"
              name="sandbox-network-policy"
              checked={info.settings.networkPolicy === o.value}
              onChange={() => save({ sandboxNetworkPolicy: o.value })}
              className="mt-1"
              aria-label={o.label}
            />
            <span>
              {o.label}——{o.hint}
            </span>
          </label>
        ))}
        <p className="text-xs text-tertiary">只作用于 Agent 执行的命令，不影响应用本身的联网。</p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">文件写入范围</legend>
        <label className="flex items-start gap-2 text-sm text-secondary">
          <input
            type="radio"
            name="sandbox-write-policy"
            checked={info.settings.writePolicy === 'confined'}
            onChange={() => save({ sandboxWritePolicy: 'confined' })}
            className="mt-1"
            aria-label="仅工作空间（推荐）"
          />
          <span>仅工作空间（推荐）——Agent 只能改动本项目文件夹里的文件；要写到其他位置时会先征求你的同意</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-secondary">
          <input
            type="radio"
            name="sandbox-write-policy"
            checked={info.settings.writePolicy === 'full-disk'}
            onChange={() => setConfirmFullDisk(true)}
            className="mt-1"
            aria-label="整台电脑"
            disabled={isWin}
          />
          <span>
            整台电脑——Agent 可直接读写电脑上绝大多数位置（桌面、下载、文稿等），不再逐次询问；系统关键位置与密钥类敏感信息仍受保护
            {isWin ? '（Windows 上暂不生效）' : ''}
          </span>
        </label>
        <p className="text-xs text-tertiary">更改立即对所有会话生效；聊天附件与文件列表始终限于工作空间内。</p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">已允许写入的位置</legend>
        {grants.length === 0 ? (
          <p className="text-xs text-tertiary">暂无额外允许的位置</p>
        ) : (
          grants.map((g) => (
            <div key={g.workspaceId} className="flex flex-col gap-1">
              {g.dirs.map((d) => (
                <div key={`${g.workspaceId}:${d}`} className="flex items-center justify-between gap-2">
                  <code className="border border-subtle bg-canvas rounded px-2 py-1 font-mono text-xs text-secondary select-all break-all">
                    {d}
                  </code>
                  <Button variant="danger" size="sm" onClick={() => setPendingRevoke({ entry: g, dir: d })}>
                    删除
                  </Button>
                </div>
              ))}
            </div>
          ))
        )}
        <p className="text-xs text-tertiary">这里列出你此前点过「允许」的文件夹；删除后，Agent 再往里写文件时会重新询问。</p>
      </fieldset>

      {pendingRevoke !== null && (
        <ConfirmDialog
          title="撤销目录授权"
          message={`确定撤销 ${pendingRevoke.dir} 的写入授权？撤销后该目录的写入将重新被沙箱拦截。`}
          confirmLabel="撤销授权"
          onConfirm={() => revokeGrant(pendingRevoke.entry, pendingRevoke.dir)}
          onClose={() => setPendingRevoke(null)}
        />
      )}

      {confirmFullDisk && (
        <ConfirmDialog
          title="允许写入整台电脑？"
          message={'开启后，Agent 无需逐次确认，即可修改这台电脑上大部分位置的文件（包括桌面、下载、文稿等个人文件夹）。\n系统关键位置与 SSH 密钥、钥匙串等敏感信息仍受保护。'}
          confirmLabel="允许"
          onConfirm={() => save({ sandboxWritePolicy: 'full-disk' })}
          onClose={() => setConfirmFullDisk(false)}
        />
      )}

      <div className="rounded-lg border border-subtle bg-surface-2 p-3 flex flex-col gap-2">
        <div className="text-sm">
          <span className="text-tertiary">当前状态：</span>
          <span className="font-mono text-xs text-secondary">{statusText}</span>
        </div>
        <Button onClick={() => void reprobe()} disabled={busy}>
          {busy ? '检测中...' : '重新检测'}
        </Button>
      </div>
    </section>
  );
}
