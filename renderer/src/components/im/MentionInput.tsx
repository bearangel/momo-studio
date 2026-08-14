// renderer/src/components/im/MentionInput.tsx
//
// 消息输入框 + @ / # 双语法菜单。
//   - 输入 @ 触发 agent 菜单（显示当前 workspace 的 assignments）
//   - 输入 # 触发任务菜单（仅显示 status in ['draft','pending','assigned'] 的任务）
//   - 选中后插入 mention 文本（@agentName 或 #T-XXX）
//   - 发送时用 MentionParser 解析，回调携带 mentions 列表
//   - 组件完全受控：value + onChange 由父组件持有
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useTaskStore } from '../../stores/task.store';
import { parseMentions, type Mention } from '../../lib/mention-parser';

interface MentionInputProps {
  value: string;
  onChange: (next: string) => void;
  onSend: (text: string, mentions: Mention[]) => void;
  roomId: string;
  workspaceId: string;
  placeholder?: string;
  disabled?: boolean;
}

type MenuKind = 'agent' | 'task';

const PENDING_TASK_STATUSES: ReadonlyArray<string> = ['draft', 'pending', 'assigned'];

export function MentionInput({
  value,
  onChange,
  onSend,
  // roomId / workspaceId 留作未来扩展（per-room mention 过滤、上传 context 等）
  roomId: _roomId,
  workspaceId: _workspaceId,
  placeholder,
  disabled,
}: MentionInputProps) {
  const { assignments = [] } = useAgentStore();
  const { tasks = [] } = useTaskStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [menuType, setMenuType] = useState<MenuKind | null>(null);
  const [query, setQuery] = useState('');

  // 根据光标位置检测当前是否在 @xxx / #T-xxx 触发态
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) {
      setMenuType(null);
      return;
    }
    const pos = ta.selectionStart;
    const before = value.slice(0, pos);
    const atMatch = before.match(/(?:^|\s)@([A-Za-z0-9-]*)$/);
    // 任务 trigger 允许任何 T-/数字 形式的局部输入；最终有效性在 filteredTasks 阶段按 id.includes(q) 过滤
    const taskMatch = before.match(/(?:^|\s)#([A-Za-z0-9-]*)$/);
    if (atMatch) {
      setMenuType('agent');
      setQuery(atMatch[1] ?? '');
    } else if (taskMatch) {
      setMenuType('task');
      setQuery(taskMatch[1] ?? '');
    } else {
      setMenuType(null);
      setQuery('');
    }
  }, [value]);

  const filteredAgents = useMemo(() => {
    if (menuType !== 'agent') return [];
    const q = query.toLowerCase();
    return assignments.filter((a) => {
      if (!a.lastRunning) return false;
      const name = a.agentName ?? a.botMatrixUserId;
      return !q || name.toLowerCase().includes(q);
    });
  }, [assignments, menuType, query]);

  const filteredTasks = useMemo(() => {
    if (menuType !== 'task') return [];
    const q = query.toLowerCase();
    return tasks.filter((t) =>
      PENDING_TASK_STATUSES.includes(t.status) &&
      (!q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)),
    );
  }, [tasks, menuType, query]);

  const insertMention = (mentionText: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    // 替换光标前最近一段 @xxx / #T-xxx
    const newValue = before.replace(/(?:^|\s)(@[A-Za-z0-9-]*$|#T-\d*$)/, (match, partial: string) => {
      return match.replace(partial, mentionText);
    }) + after;
    onChange(newValue);
    setMenuType(null);
    setQuery('');
    // 焦点回到 textarea，光标停在 mention 末尾
    setTimeout(() => {
      ta.focus();
      const newPos = newValue.length - after.length;
      ta.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const handleSend = () => {
    if (disabled) return;
    if (!value.trim()) return;
    const mentions = parseMentions(value);
    onSend(value, mentions);
    onChange('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') {
      setMenuType(null);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'flex-end', padding: 8 }}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? '输入消息，@ 提到 agent，# 引用任务'}
        disabled={disabled}
        style={{ flex: 1, minHeight: 40, maxHeight: 200, resize: 'vertical' }}
      />
      <button type="button" onClick={handleSend} disabled={disabled || !value.trim()}>
        发送
      </button>

      {menuType === 'agent' && filteredAgents.length > 0 && (
        <div style={menuStyle}>
          {filteredAgents.slice(0, 10).map((a) => {
            const name = a.agentName ?? a.botMatrixUserId;
            return (
              <button
                key={a.instanceId}
                type="button"
                onClick={() => insertMention(`@${name}`)}
                style={menuItemStyle}
              >
                👤 {name}
              </button>
            );
          })}
        </div>
      )}

      {menuType === 'task' && filteredTasks.length > 0 && (
        <div style={menuStyle}>
          {filteredTasks.slice(0, 10).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => insertMention(`#${t.id}`)}
              style={menuItemStyle}
            >
              📌 {t.id} · {t.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const menuStyle: React.CSSProperties = {
  position: 'absolute', bottom: '100%', left: 8, right: 8,
  backgroundColor: '#1f2937', border: '1px solid #374151',
  borderRadius: 6, padding: 4, zIndex: 50, maxHeight: 240, overflowY: 'auto',
};
const menuItemStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left',
  padding: '6px 8px', color: '#e5e7eb', cursor: 'pointer', background: 'transparent', border: 'none',
};
