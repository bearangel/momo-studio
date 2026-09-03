// renderer/src/components/settings/MemorySettings.tsx
// v2.2 记忆管理页（spec §7.3）：全局/工作空间双层 tab + 列表（置顶/编辑/删除）+ 总开关。
// 会话层记忆从会话详情入口进入（P2）；本页新增固定 user 视角（source='user'）。
// 总开关经 settings.updateGlobal 的 memoryEnabled（false = 注入与提取暂停）。
import { useCallback, useEffect, useState } from 'react';
import { Brain, Pin, PinOff, Pencil, Trash2, Plus } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { MemoryEntry, MemoryListScope } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';

type ScopeTab = 'workspace' | 'global';

// kind 中文标签（列表元信息行展示用；枚举值本身是 IPC 契约不改）
const KIND_LABEL: Record<MemoryEntry['kind'], string> = {
  rule: '规则',
  preference: '偏好',
  knowledge: '知识',
  summary: '摘要',
};

// 新增对话框 kind 可选值（默认 rule——常驻注入由此生效）
const KIND_OPTIONS: Array<{ value: MemoryEntry['kind']; label: string }> = [
  { value: 'rule', label: '规范' },
  { value: 'preference', label: '偏好' },
  { value: 'knowledge', label: '知识' },
  { value: 'summary', label: '摘要' },
];

export function MemorySettings({ workspaceId }: { workspaceId: string }) {
  const [tab, setTab] = useState<ScopeTab>('workspace');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  // v2.2 P2：自动提取子开关（独立于总开关；总开关停用时强制禁用）
  const [memoryExtractionEnabled, setMemoryExtractionEnabled] = useState(true);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [editText, setEditText] = useState('');
  const [confirming, setConfirming] = useState<MemoryEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [newText, setNewText] = useState('');
  const [newKind, setNewKind] = useState<MemoryEntry['kind']>('rule');

  // 按 tab 构造 scope 拉列表（filter 位本页未消费，省略）
  const reload = useCallback(() => {
    const scope: MemoryListScope = tab === 'global'
      ? { kind: 'global' }
      : { kind: 'workspace', workspaceId };
    ipc.memory.list(scope).then(setEntries);
  }, [tab, workspaceId]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    // memoryEnabled/memoryExtractionEnabled 缺省 true（老库未写入时维持启用）
    ipc.settings.getGlobal().then((s) => {
      setMemoryEnabled(s.memoryEnabled !== false);
      setMemoryExtractionEnabled(s.memoryExtractionEnabled !== false);
    });
  }, []);

  const togglePin = async (e: MemoryEntry) => {
    await ipc.memory.update(e.id, { pinned: !e.pinned });
    reload();
  };

  const saveEdit = async () => {
    if (editing && editText.trim()) {
      await ipc.memory.update(editing.id, { content: editText.trim() });
    }
    setEditing(null);
    reload();
  };

  const doDelete = async () => {
    if (confirming) {
      await ipc.memory.delete(confirming.id);
    }
    setConfirming(null);
    reload();
  };

  const toggleEnabled = async () => {
    const next = !memoryEnabled;
    setMemoryEnabled(next);
    await ipc.settings.updateGlobal({ memoryEnabled: next });
  };

  // v2.2 P2：自动提取子开关——独立 IPC 通道（settings.updateGlobal），与总开关解耦。
  // 总开关停用时按钮禁用（hide 无意义，disable + 提示让用户看见关联原因）
  const toggleExtraction = async () => {
    const next = !memoryExtractionEnabled;
    setMemoryExtractionEnabled(next);
    await ipc.settings.updateGlobal({ memoryExtractionEnabled: next });
  };

  // 新增跟随当前 tab 落 scope；kind 用户可选（默认 rule，常驻注入由此生效）；
  // pinned 由 repo 按 kind 推导（rule/preference=常驻），不显式传
  const doCreate = async () => {
    if (!newText.trim()) return;
    await ipc.memory.save(
      tab === 'global'
        ? { scope: 'global', kind: newKind, content: newText.trim(), source: 'user' }
        : { scope: 'workspace', workspaceId, kind: newKind, content: newText.trim(), source: 'user' },
    );
    setCreating(false);
    setNewText('');
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base text-primary font-medium flex items-center gap-2">
          <Brain size={16} strokeWidth={1.75} aria-hidden /> 记忆
        </h2>
        <div className="flex items-center gap-2">
          {/* v2.2 P2：自动提取子开关——独立于总开关；总开关停用时禁用 + 下方红字提示 */}
          <button
            type="button"
            aria-label="自动提取开关"
            onClick={toggleExtraction}
            disabled={!memoryEnabled}
            className={`text-sm px-3 py-1.5 rounded border transition-colors ${
              memoryExtractionEnabled
                ? 'border-subtle text-secondary hover:bg-surface-3'
                : 'border-status-error text-status-error'
            } disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
          >
            自动提取{memoryExtractionEnabled ? '已启用' : '已停用'}
          </button>
          <button
            type="button"
            aria-label="记忆总开关"
            onClick={toggleEnabled}
            className={`text-sm px-3 py-1.5 rounded border transition-colors ${
              memoryEnabled
                ? 'border-subtle text-secondary hover:bg-surface-3'
                : 'border-status-error text-status-error'
            }`}
          >
            {memoryEnabled ? '已启用' : '已停用（注入与提取暂停）'}
          </button>
        </div>
      </div>
      {!memoryEnabled && (
        <p className="text-xs text-status-error">记忆总开关已停用</p>
      )}
      {/* v2.2 P2：提取前置条件静态说明——会话级 agent 必须配置模型供应商 */}
      <p className="text-xs text-tertiary">提取需要会话 agent 已配置模型供应商</p>

      <div className="flex items-center gap-1 border-b border-subtle">
        {(['workspace', 'global'] as ScopeTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-label={t === 'workspace' ? '工作空间' : '全局'}
            className={`px-3 py-1.5 text-sm rounded-t border-b-2 transition-colors ${
              tab === t ? 'border-accent-600 dark:border-accent-300 text-primary' : 'border-transparent text-secondary hover:text-primary'
            }`}
          >
            {t === 'workspace' ? '工作空间' : '全局'}
          </button>
        ))}
      </div>

      <div>
        <Button variant="secondary" size="sm" onClick={() => { setCreating(true); setNewText(''); setNewKind('rule'); }}>
          <Plus size={16} strokeWidth={1.75} aria-hidden /> 新增记忆
        </Button>
      </div>

      <ul className="flex flex-col gap-2" aria-label="记忆列表">
        {entries.map((e) => (
          <li key={e.id} className="border border-subtle rounded p-3 bg-surface-1 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm text-primary whitespace-pre-wrap flex-1">{e.content}</div>
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" aria-label={e.pinned ? '取消置顶' : '置顶'} onClick={() => togglePin(e)}
                  className="p-1.5 rounded text-secondary hover:bg-surface-3 hover:text-primary">
                  {e.pinned ? <Pin size={16} strokeWidth={1.75} aria-hidden /> : <PinOff size={16} strokeWidth={1.75} aria-hidden />}
                </button>
                <button type="button" aria-label="编辑" onClick={() => { setEditing(e); setEditText(e.content); }}
                  className="p-1.5 rounded text-secondary hover:bg-surface-3 hover:text-primary">
                  <Pencil size={16} strokeWidth={1.75} aria-hidden />
                </button>
                <button type="button" aria-label="删除" onClick={() => setConfirming(e)}
                  className="p-1.5 rounded text-secondary hover:bg-surface-3 hover:text-status-error">
                  <Trash2 size={16} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            </div>
            <div className="text-xs text-tertiary">
              {KIND_LABEL[e.kind]} · 来源 {e.source === 'user' ? '用户' : e.source === 'agent' ? 'agent' : '自动提取'}
              {e.pinned ? ' · 常驻注入' : ' · 检索型'}
            </div>
          </li>
        ))}
        {entries.length === 0 && <li className="text-sm text-tertiary">暂无记忆条目</li>}
      </ul>

      {editing && (
        <Dialog open title="编辑记忆" onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>取消</Button>
              <Button size="sm" onClick={saveEdit}>保存</Button>
            </>
          }
        >
          <Input value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="记忆内容" />
        </Dialog>
      )}

      {creating && (
        <Dialog open title="新增记忆" onClose={() => setCreating(false)}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setCreating(false)}>取消</Button>
              <Button size="sm" onClick={doCreate}>保存</Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Input value={newText} onChange={(e) => setNewText(e.target.value)} aria-label="新记忆内容" placeholder="例如：本工作空间研发规范……" />
            <Select
              aria-label="记忆类型"
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as MemoryEntry['kind'])}
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </div>
        </Dialog>
      )}

      {confirming && (
        <Dialog open title="删除记忆" onClose={() => setConfirming(null)}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>取消</Button>
              <Button variant="danger" size="sm" onClick={doDelete}>确认</Button>
            </>
          }
        >
          <p className="text-sm text-secondary">确定删除这条记忆？不可恢复。</p>
        </Dialog>
      )}
    </div>
  );
}
