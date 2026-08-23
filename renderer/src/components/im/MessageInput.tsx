// renderer/src/components/im/MessageInput.tsx
import { useState, useCallback, useEffect, type KeyboardEvent } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';
import type { AgentAssignment } from '../../ipc/types';

export function MessageInput() {
  const [text, setText] = useState('');
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  // v2.0 P1 Task 9：pendingMentions 存 assignmentId（instanceId），
  // 经 store.sendMessage(body, mentionedAssignmentIds) 透传给 session:send。
  const [pendingMentions, setPendingMentions] = useState<string[]>([]);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const members = useSessionStore((s) => s.members);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { assignments, loadAssignments, definitions, loadDefinitions } = useAgentStore();
  const botNameMap = useBotNameMap();

  useEffect(() => {
    if (workspace) {
      void loadAssignments(workspace.id);
      if (definitions.length === 0) void loadDefinitions();
    }
  }, [workspace, loadAssignments, definitions.length, loadDefinitions]);

  const agentsInWorkspace = assignments.filter(
    (a) =>
      a.enabled &&
      a.lastRunning &&
      members.some((m) => m.assignmentId === a.instanceId),
  );

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !activeSessionId) return;
    const mentions = pendingMentions.length > 0 ? [...pendingMentions] : undefined;
    setText('');
    setPendingMentions([]);
    setMentionMenuOpen(false);
    try {
      await sendMessage(trimmed, mentions);
      await loadSessions();
    } catch {
      setText(trimmed);
      if (mentions) setPendingMentions(mentions);
    }
  }, [text, activeSessionId, pendingMentions, sendMessage, loadSessions]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionMenuOpen && e.key === 'Escape') {
        setMentionMenuOpen(false);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !mentionMenuOpen) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend, mentionMenuOpen],
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart ?? newValue.length;
    setText(newValue);
    const beforeCursor = newValue.slice(0, cursorPos);
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);
    if (atMatch) {
      setMentionMenuOpen(true);
      setMentionQuery(atMatch[1] ?? '');
      setMentionStart(cursorPos - atMatch[0].length);
    } else {
      setMentionMenuOpen(false);
    }
  };

  const selectMention = (agent: AgentAssignment) => {
    const before = text.slice(0, mentionStart);
    const after = text.slice(mentionStart + mentionQuery.length + 1);
    const display = resolveBotName(agent.agentUserId ?? '', botNameMap);
    const newText = `${before}@${display} ${after}`;
    setText(newText);
    setPendingMentions((prev) =>
      prev.includes(agent.instanceId) ? prev : [...prev, agent.instanceId],
    );
    setMentionMenuOpen(false);
  };

  /** assignmentId → 展示名（mention chip 用；回退 agentName → agentUserId 解析） */
  const mentionDisplayName = (assignmentId: string): string => {
    const a = assignments.find((x) => x.instanceId === assignmentId);
    if (!a) return assignmentId;
    return a.agentName ?? resolveBotName(a.agentUserId ?? '', botNameMap);
  };

  const filteredAgents = mentionQuery
    ? agentsInWorkspace.filter((a) =>
        resolveBotName(a.agentUserId ?? '', botNameMap)
          .toLowerCase()
          .includes(mentionQuery.toLowerCase()),
      )
    : agentsInWorkspace;

  return (
    <div className="border-t border-border-subtle bg-bg-secondary p-3 relative">
      {mentionMenuOpen && filteredAgents.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-bg-tertiary border border-border-subtle rounded-lg shadow-xl py-1 max-h-48 overflow-auto z-50">
          <div className="px-3 py-1 text-xs text-neutral-500">选择要 @ 的 agent</div>
          {filteredAgents.map((agent) => {
            const displayName = resolveBotName(agent.agentUserId ?? '', botNameMap);
            return (
              <button
                key={agent.instanceId}
                type="button"
                onClick={() => selectMention(agent)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-bg-primary flex items-center gap-2"
              >
                <span>🤖</span>
                <span className="truncate">{displayName}</span>
              </button>
            );
          })}
        </div>
      )}

      {pendingMentions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {pendingMentions.map((assignmentId) => {
            const name = mentionDisplayName(assignmentId);
            return (
              <button
                key={assignmentId}
                type="button"
                onClick={() => setPendingMentions((prev) => prev.filter((m) => m !== assignmentId))}
                className="text-xs px-2 py-0.5 rounded bg-accent-blue/20 text-accent-blue hover:bg-red-500/20 hover:text-red-400"
              >
                @{name} ×
              </button>
            );
          })}
        </div>
      )}

      <textarea
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={!activeSessionId}
        placeholder={activeSessionId ? '输入消息，Enter 发送。输入 @ 选择 agent' : '请先选择房间'}
        rows={2}
        className="w-full resize-none rounded-md bg-bg-tertiary border border-border-subtle px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-accent-blue focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
