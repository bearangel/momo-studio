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
//
// 2026-09-26 多模态 Task 10（spec §10/§11）：
//   - context_json.images 缩略图行：经 ipc.asset.readDataUrl 读 data URL，
//     纯展示无点击；读取失败 / img 解码失败 → ImageOff「图片不可用」占位
import { useEffect, useState } from 'react';
import { Zap, FileText, ImageOff } from 'lucide-react';
import type { ImMessage, SkillContextItem, FileContextItem, ImageContextItem } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { useStreamStore } from '../../stores/stream.store';
import { useEditorStore } from '../../stores/editor.store';
import { parseMessageContext } from '../../lib/message-context';
import { loadAssetDataUrl } from '../../lib/asset-data-url';
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

function isRenderableImage(i: ImageContextItem): boolean {
  return typeof i?.path === 'string' && i.path.length > 0;
}

/**
 * 单张 context 图片缩略图（spec §10：max-w-60 圆角、纯展示无点击）。
 * data URL 经 loadAssetDataUrl 取（模块级缓存防 stream 重渲染请求风暴）；
 * workspaceId 缺失（异常数据）/ IPC 失败 / img onerror → ImageOff「图片不可用」。
 */
function ContextImageThumb({ workspaceId, image }: { workspaceId: string | null; image: ImageContextItem }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (workspaceId === null) {
      setFailed(true);
      return;
    }
    let alive = true;
    loadAssetDataUrl(workspaceId, image.path)
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, image.path]);

  if (failed || src === null) {
    if (failed) {
      return (
        <span
          className="inline-flex items-center gap-1 rounded bg-surface-active px-2 py-0.5 text-xs text-secondary"
          data-testid="image-fallback"
        >
          <ImageOff size={11} strokeWidth={1.75} aria-hidden />
          图片不可用
        </span>
      );
    }
    // 载入中占位（避免 img 弹出时布局跳动）：按 context 自带 w/h 撑出同比例骨架
    return (
      <div
        className="w-24 animate-pulse rounded-lg border border-subtle bg-surface-active"
        style={{ aspectRatio: `${image.w} / ${image.h}` }}
      />
    );
  }

  return (
    <img
      src={src}
      alt={image.path}
      title={image.path}
      onError={() => setFailed(true)}
      className="max-w-60 rounded-lg border border-subtle"
    />
  );
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
  // images 已由 parseMessageContext 做过整体形状校验（元素均含 path/w/h），此处只滤 path
  const ctxImages = ctx?.images?.filter(isRenderableImage) ?? [];
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
      {ctxImages.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid="message-context-images">
          {ctxImages.map((image) => (
            <ContextImageThumb key={`img-${image.path}`} workspaceId={message.workspaceId} image={image} />
          ))}
        </div>
      )}
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
