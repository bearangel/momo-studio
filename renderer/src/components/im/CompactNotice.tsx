// renderer/src/components/im/CompactNotice.tsx
//
// /compact 确认消息卡片（eventType io.momo-studio.compact，生产者
// electron im/session-service.ts handleSessionCommand）。
//
// body 文本协议（与主进程 commands.ts COMPACT_ACK_EVENT_TYPE 注释成对维护）：
//   首行 = 统计行（「已压缩 N 条历史消息（摘要自下轮生效）」）
//   首个空行后 = 摘要正文（可无——LAN 只读镜像的广播行只含统计行）
//
// 呈现为居中系统通知（非气泡、不归属任何对话角色——取代旧版冒充 owner
// 气泡的 `[系统] 会话已压缩…` 文本）；摘要默认折叠，展开经 MarkdownBody 渲染。
import { useState } from 'react';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import type { ImMessage } from '../../ipc/types';
import { MarkdownBody } from './MarkdownBody';

/**
 * body 文本协议防御性解析（导出供契约测试：生产者真实输出 → 本消费方直接切分）。
 * 无空行 / 空行后无内容 → 整体当统计行、无折叠区（LAN 镜像行与异常数据同路径）。
 */
export function splitCompactBody(body: string): { title: string; summary: string | null } {
  const idx = body.indexOf('\n\n');
  if (idx === -1) return { title: body, summary: null };
  const summary = body.slice(idx + 2);
  return { title: body.slice(0, idx), summary: summary.trim() === '' ? null : summary };
}

interface Props {
  message: ImMessage;
}

export function CompactNotice({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { title, summary } = splitCompactBody(message.body);

  return (
    <div data-testid="compact-notice" className="my-2 flex justify-center px-4">
      {/* 宽度与 MessageFrame 默认气泡同比例（70%）——随窗口/中栏宽度按比例伸缩，
          宽屏不脱队；居中通知不随内容收缩策略与气泡 fillWidth 语义无关 */}
      <div className="flex max-w-[70%] flex-col rounded-lg border border-subtle bg-surface-2 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-secondary">
          <Archive size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
          <span className="min-w-0 break-all">{title}</span>
          {summary !== null && (
            <button
              type="button"
              data-testid="compact-summary-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex shrink-0 items-center gap-0.5 text-secondary transition-colors hover:text-primary"
            >
              {expanded ? '收起摘要' : '查看摘要'}
              {expanded ? (
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
              ) : (
                <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
              )}
            </button>
          )}
        </div>
        {expanded && summary !== null && (
          <div data-testid="compact-summary" className="mt-2 border-t border-subtle pt-2 text-sm text-primary">
            <MarkdownBody>{summary}</MarkdownBody>
          </div>
        )}
      </div>
    </div>
  );
}
