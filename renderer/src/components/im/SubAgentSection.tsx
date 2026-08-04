// renderer/src/components/im/SubAgentSection.tsx
//
// 子 agent 嵌套工作区（v1.4）：渲染在 DispatchChip 展开后的内部区域。
// 复用 ThinkingSection / ToolCallChip / 流式正文，但与 AgentStreamBubble 的差异：
//   - 左边框竖线（视觉关联到所属 dispatch chip，体现嵌套层级）
//   - 不渲染 MessageFrame 外壳（DispatchChip 自带紧凑头行）
//   - 不渲染底部状态栏 / 停止按钮（由顶层 AgentStreamBubble 统一管理）
//   - 不递归渲染 dispatch chips（spec §12 限制最多 3 层，子 agent 不再嵌套委派）
//
// 本组件是「去壳的 AgentStreamBubble 内芯」：思考区 + 工具卡片 + 正文（含流式光标）。
import type { StreamState } from '../../stores/stream.store';
import { ThinkingSection } from './ThinkingSection';
import { ToolCallChip } from './ToolCallChip';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  /** 子 agent 的流式聚合状态（从 streams Map 按 subStreamSessionId 查找后传入） */
  stream: StreamState;
}

export function SubAgentSection({ stream }: Props) {
  const isStreaming = stream.status === 'streaming';

  return (
    <div
      style={{
        // 左边框竖线：视觉上把子 agent 工作区锚定到 dispatch chip 下方
        borderLeft: '2px solid #444',
        paddingLeft: 8,
        marginTop: 4,
        marginBottom: 4,
      }}
    >
      <ThinkingSection content={stream.thinking} isStreaming={isStreaming} />

      {stream.toolCalls.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {stream.toolCalls.map((tc, i) => (
            <ToolCallChip
              key={`${tc.toolName}-${i}`}
              toolName={tc.toolName}
              args={tc.args}
              result={tc.result}
              success={tc.success ?? true}
              isExecuting={tc.isExecuting}
              defaultExpanded={false}
            />
          ))}
        </div>
      )}

      {stream.text && (
        <div className="overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{stream.text}</ReactMarkdown>
          {isStreaming && (
            <span
              aria-label="子 agent 流式光标"
              style={{
                display: 'inline-block',
                width: 2,
                height: 14,
                background: '#60a5fa',
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                // 复用顶层 AgentStreamBubble 定义的 keyframes（嵌套场景下父级一定存在）
                animation: 'momo-stream-blink 1s infinite',
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
