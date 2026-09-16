// renderer/src/components/im/MessageBubble.tsx
//
// 单条消息渲染入口。根据 eventType 分发：
//   - io.momo-studio.dispatch   → DispatchCard（紫色，走 MessageFrame）
//   - io.momo-studio.task_reply → TaskReplyCard（状态色，走 MessageFrame）
//   - m.room.message（含活跃 stream 或已完成带富信息） → AgentStreamBubble
//   - 其余 → 普通气泡（走 MessageFrame，自己蓝/他人灰）
//
// v2.0 A 子系统重写：
//   - 按 message.id 查 stream.store.get()，streaming 时渲染 AgentStreamBubble
//   - 已完成（done/failed/aborted）但带富信息（thinking/工具调用/dispatches）时
//     也走 AgentStreamBubble——从 message_events 聚合重建，重启后一致
//
// v2.1 渲染收敛：
//   - 消息体经 MarkdownBody 统一渲染（v2.1 收敛），SafeAnchor/CodeBlock/表格滚动容器全调用点一致
//
// v2.1 会话渲染优化：
//   - 删除本地 SafeAnchor 副本，正文经 MarkdownBody 统一入口（S2 链接拦截一致）
//   - 静态气泡补时间戳；agent 回复（非自己）hover 气泡显示复制按钮
//
// v2.11 Task 11：
//   - owner 消息 body 上方渲染输入上下文 chip 行：技能 chip 纯展示、文件 chip
//     点击 file:read(workspaceId, path) 后打开编辑器 tab；读取失败降级 disabled
import { useState } from 'react';
import { Zap, FileText } from 'lucide-react';
import type { ImMessage, SkillContextItem, FileContextItem } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { useStreamStore } from '../../stores/stream.store';
import { useEditorStore } from '../../stores/editor.store';
import { parseMessageContext } from '../../lib/message-context';
import { cn } from '../../lib/cn';
import { DispatchCard } from './DispatchCard';
import { TaskReplyCard } from './TaskReplyCard';
import { MessageFrame } from './MessageFrame';
import { AgentStreamBubble } from './AgentStreamBubble';
import { MarkdownBody } from './MarkdownBody';
import { CopyButton } from '../ui/CopyButton';

// 信任边界：parseMessageContext 只校验 skills/files 是数组，不校验项内字段
// （Task 1 已知 Minor）。chip 渲染处过滤缺字段项——s.name 直接渲染、
// f.path.split('/') 对 undefined 都会抛 TypeError，损坏 contextJson 不能崩气泡。
function isRenderableSkill(s: SkillContextItem): boolean {
  return typeof s?.slug === 'string' && typeof s?.name === 'string';
}

function isRenderableFile(f: FileContextItem): boolean {
  return typeof f?.path === 'string' && f.path.length > 0;
}

interface Props {
  message: ImMessage;
  isSelf: boolean;
  /** bot 的配置名称（如有），优先于 shortName 展示 */
  senderName?: string;
}

export function MessageBubble({ message, isSelf, senderName }: Props) {
  // A 子系统：按 message.id 查 stream。streaming 或已完成带富信息时用 AgentStreamBubble
  // 渲染（thinking/工具调用/dispatches 从 message_events 聚合），否则渲染静态消息。
  const stream = useStreamStore((s) => s.streams.get(message.id));
  // v2.11 Task 11：文件 chip 读取失败降级记录（失败一次即置 disabled，不崩不弹窗）
  const [failedPaths, setFailedPaths] = useState<string[]>([]);

  /** 文件 chip 点击：读 workspace 文件后打开编辑器 tab；失败记入 failedPaths 置 disabled */
  async function openInEditor(filePath: string): Promise<void> {
    // owner 消息落库必带 workspaceId（sendUserMessage 写入 session.workspaceId）；
    // 缺失属异常数据——直接走失败降级，不发必然失败的 IPC
    if (message.workspaceId === null) {
      markFailed(filePath);
      return;
    }
    try {
      const content = await ipc.file.read(message.workspaceId, filePath);
      useEditorStore.getState().openFile(filePath, content);
    } catch {
      markFailed(filePath);
    }
  }

  function markFailed(filePath: string): void {
    setFailedPaths((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
  }

  // v2.11 Task 11：owner 消息的输入上下文 chips。agent 消息不渲染（上下文只随
  // 用户输入产生）；解析失败 / 项全非法 / 均空数组 → 无 chip 行。
  // I3：P2P 远端镜像的 owner 消息经 sync 改写 sender 为 remote:<nodeId>[:<原sender>]，
  // 门控放宽为前缀匹配——远端用户的 context 同样渲染 chip。
  const ctx =
    message.sender === 'owner' || message.sender.startsWith('remote:')
      ? parseMessageContext(message.contextJson)
      : null;
  const ctxSkills = ctx?.skills.filter(isRenderableSkill) ?? [];
  const ctxFiles = ctx?.files.filter(isRenderableFile) ?? [];
  const hasContextChips = ctxSkills.length > 0 || ctxFiles.length > 0;

  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
  }

  // 流式中 OR 已完成但带富信息 OR 失败带错误文本：用 AgentStreamBubble 渲染——
  // 否则错误（含失败的具体原因）会被静态气泡吞掉不可见（2.0.0 主机验收 P0-3）。
  if (
    stream &&
    (stream.status === 'streaming' ||
      stream.status === 'failed' ||
      stream.error !== undefined ||
      stream.thinking.length > 0 ||
      stream.toolCalls.length > 0 ||
      stream.dispatches.length > 0)
  ) {
    return <AgentStreamBubble stream={stream} message={message} senderName={senderName} />;
  }

  // 静态气泡（普通文本消息，或已完成但无富信息的 agent 回复）
  return (
    <MessageFrame
      sender={message.sender}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName={cn(
        'relative group',
        isSelf ? 'bg-accent-500 text-inverse' : 'bg-surface-2 text-primary',
      )}
      timestamp={message.createdAt}
    >
      {hasContextChips && (
        <div className="mb-1.5 flex flex-wrap gap-1" data-testid="message-context-chips">
          {ctxSkills.map((s) => (
            <span
              key={`skill-${s.slug}`}
              className="inline-flex items-center gap-1 rounded bg-surface-active px-2 py-0.5 text-xs text-accent-600 dark:text-accent-300"
            >
              <Zap size={11} strokeWidth={1.75} aria-hidden />
              {s.name}
            </span>
          ))}
          {ctxFiles.map((f) => (
            <button
              key={`file-${f.path}`}
              type="button"
              aria-label={f.path}
              title={f.path}
              disabled={failedPaths.includes(f.path)}
              onClick={() => void openInEditor(f.path)}
              className="inline-flex items-center gap-1 rounded bg-surface-active px-2 py-0.5 text-xs text-secondary hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileText size={11} strokeWidth={1.75} aria-hidden />
              {f.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      <MarkdownBody>{message.body}</MarkdownBody>
      {!isSelf && (
        <CopyButton
          text={message.body}
          className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
      )}
    </MessageFrame>
  );
}
