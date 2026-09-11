// renderer/src/components/settings/BrowserSettings.tsx
//
// v2.7 设置页「浏览器」分类（spec §6.2，与「安全沙箱」并列）：
//   - 信任级别单选（每次询问默认 / 永久允许 / 拒绝）
//   - 域名黑白名单 textarea（每行一条；T1 裁定：白名单非空时仅白名单放行，
//     黑名单仅当白名单为空时生效——帮助文案明示）
//   - browser_evaluate 开关（默认关 + 警示文案「开启后 agent 可执行任意页面 JS」）
//   - 侧栏默认宽度 + 默认折叠
//   - 「清除浏览数据」（Dialog confirm 防误触 → clearBrowsingData 清 partition）
// 读写经 ipc.browser.getSettings / updateSettings（结构化 {ok,error} 返回——
// 失败呈现错误行，保存成功才翻转本地态）。名单/宽度走本地编辑、blur 提交
// （拆行 trim 丢空行；非法宽度不提交回显原值）。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { BrowserSettings as BrowserSettingsShape, BrowserSettingsPatch } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

interface Props {
  workspaceId: string;
}

const TRUST_OPTIONS: { value: BrowserSettingsShape['trust']; label: string }[] = [
  { value: 'ask', label: '每次询问（默认）' },
  { value: 'always', label: '永久允许' },
  { value: 'deny', label: '拒绝' },
];

/** textarea 文本 → 每行一条名单（trim / 丢空行；归一化由主进程 store 写侧单点负责） */
function textToList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function BrowserSettings({ workspaceId }: Props) {
  const [settings, setSettings] = useState<BrowserSettingsShape | null>(null);
  const [blacklistText, setBlacklistText] = useState('');
  const [whitelistText, setWhitelistText] = useState('');
  const [widthText, setWidthText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ipc.browser
      .getSettings(workspaceId)
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setBlacklistText(s.blacklist.join('\n'));
        setWhitelistText(s.whitelist.join('\n'));
        setWidthText(String(s.sidebarWidth));
      })
      .catch(() => {
        // 读失败保持「加载中」占位——设置页非关键路径，不抛错误给全局
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!settings) return <div className="p-4 text-secondary text-sm">加载中...</div>;

  // 保存成功才翻转本地态；失败保留原值 + 错误行（决策未完成可重试）
  const save = async (patch: BrowserSettingsPatch): Promise<void> => {
    const res = await ipc.browser.updateSettings(workspaceId, patch);
    if (res.ok) {
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      setError(null);
    } else {
      setError(res.error);
    }
  };

  const commitBlacklist = (): void => {
    const list = textToList(blacklistText);
    // 同步回显归一前文本（拆行 trim 后形态），避免「已保存但显示未 trim 行」漂移
    setBlacklistText(list.join('\n'));
    void save({ blacklist: list });
  };

  const commitWhitelist = (): void => {
    const list = textToList(whitelistText);
    setWhitelistText(list.join('\n'));
    void save({ whitelist: list });
  };

  const commitWidth = (): void => {
    const parsed = Number(widthText.trim());
    if (widthText.trim().length === 0 || !Number.isFinite(parsed) || parsed <= 0) {
      // 非法输入不提交、回显落库原值
      setWidthText(String(settings.sidebarWidth));
      return;
    }
    void save({ sidebarWidth: parsed });
  };

  const doClear = async (): Promise<void> => {
    setClearing(true);
    try {
      await ipc.browser.clearBrowsingData(workspaceId);
      setConfirmingClear(false);
      setError(null);
    } catch (err) {
      // 失败保留确认弹窗语境外的错误行，弹窗关闭（不静默吞）
      setConfirmingClear(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="flex flex-col gap-6" aria-label="浏览器设置">
      <div>
        <h2 className="text-base text-primary mb-1">浏览器</h2>
        <p className="text-sm text-secondary">
          agent 浏览器工具的信任与网络策略（浏览器是独立于 bash 沙箱的唯一网络策略层）。
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">信任级别</legend>
        {TRUST_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="radio"
              name="browser-trust"
              checked={settings.trust === o.value}
              onChange={() => void save({ trust: o.value })}
              className="mt-1"
              aria-label={o.label}
            />
            <span>
              {o.label}
              {o.value === 'ask' && '——首次调用浏览器工具时弹卡询问'}
              {o.value === 'deny' && '——浏览器工具直接失败'}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-primary">域名策略</div>
        <p className="text-xs text-tertiary">每行一条域名（scheme / 端口自动归一）</p>
        <p className="text-xs text-tertiary">白名单非空时仅白名单放行（黑名单仅当白名单为空时生效）</p>
        <div className="flex flex-col gap-1">
          <label htmlFor="browser-whitelist" className="text-sm text-secondary">
            白名单（空 = 全放行；localhost 恒放行）
          </label>
          <textarea
            id="browser-whitelist"
            aria-label="域名白名单"
            value={whitelistText}
            onChange={(e) => setWhitelistText(e.target.value)}
            onBlur={commitWhitelist}
            rows={3}
            className="w-full rounded-md border border-subtle bg-canvas px-3 py-2 font-mono text-xs text-secondary"
            placeholder={'good.com\nanother.com'}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="browser-blacklist" className="text-sm text-secondary">
            黑名单（域名及子域命中即拒）
          </label>
          <textarea
            id="browser-blacklist"
            aria-label="域名黑名单"
            value={blacklistText}
            onChange={(e) => setBlacklistText(e.target.value)}
            onBlur={commitBlacklist}
            rows={3}
            className="w-full rounded-md border border-subtle bg-canvas px-3 py-2 font-mono text-xs text-secondary"
            placeholder={'evil.com\ntracker.io'}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-primary">页面脚本执行</div>
        <label className="flex items-center gap-2 text-sm text-secondary">
          <input
            type="checkbox"
            checked={settings.evaluateEnabled}
            onChange={(e) => void save({ evaluateEnabled: e.target.checked })}
            aria-label="允许 browser_evaluate"
          />
          <span>允许 browser_evaluate 工具（默认关闭）</span>
        </label>
        <p className="text-xs text-status-warning">
          开启后 agent 可执行任意页面 JS
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium text-primary">侧栏</div>
        <div className="flex items-center gap-3 text-sm text-secondary">
          <label htmlFor="browser-sidebar-width">侧栏默认宽度</label>
          <input
            id="browser-sidebar-width"
            aria-label="侧栏默认宽度"
            type="number"
            value={widthText}
            onChange={(e) => setWidthText(e.target.value)}
            onBlur={commitWidth}
            className="w-24 rounded-md border border-subtle bg-canvas px-2 py-1 text-xs text-secondary"
          />
          <span className="text-xs text-tertiary">px</span>
        </div>
        <label className="flex items-center gap-2 text-sm text-secondary">
          <input
            type="checkbox"
            checked={settings.sidebarCollapsed}
            onChange={(e) => void save({ sidebarCollapsed: e.target.checked })}
            aria-label="默认折叠"
          />
          <span>默认折叠（重启后侧栏以折叠态挂载）</span>
        </label>
      </div>

      {error !== null && (
        <div className="rounded border border-status-error/40 bg-status-error-tint px-3 py-2 text-xs text-status-error">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-subtle bg-surface-2 p-3 flex flex-col gap-2">
        <div className="text-sm">
          <span className="text-tertiary">浏览数据：</span>
          <span className="text-xs text-secondary">cookies / 缓存 / 站点存储（登录态一并清除）</span>
        </div>
        <Button variant="danger" onClick={() => setConfirmingClear(true)}>
          清除浏览数据
        </Button>
      </div>

      {confirmingClear && (
        <Dialog
          open
          title="清除浏览数据"
          onClose={() => setConfirmingClear(false)}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setConfirmingClear(false)}>
                取消
              </Button>
              <Button variant="danger" size="sm" disabled={clearing} onClick={() => void doClear()}>
                {clearing ? '清除中…' : '确认'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-secondary">
            将清除浏览器分区存储的 cookies、缓存与站点数据，不可恢复。确定继续？
          </p>
        </Dialog>
      )}
    </section>
  );
}
