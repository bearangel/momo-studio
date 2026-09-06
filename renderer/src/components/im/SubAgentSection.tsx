// renderer/src/components/im/SubAgentSection.tsx
//
// 子 agent 嵌套工作区：渲染在 DispatchChip 展开后的内部区域。
// 与 AgentStreamBubble 的差异：
//   - 左边框竖线 + 低对比度底色（spec §4.5：比气泡 --surface-2 深一档），
//     视觉关联到所属 dispatch chip，体现嵌套层级
//   - 不渲染 MessageFrame 外壳（DispatchChip 自带紧凑头行）
//   - 不渲染底部状态栏 / 停止按钮（由顶层 AgentStreamBubble 统一管理）
//   - 不递归渲染 dispatch chips（spec §12 限制最多 3 层，子 agent 不再嵌套委派）
//
// 按 segments 时间线渲染（与主气泡同构）：思考段独立折叠、工具卡片嵌在
// 触发位置、text 段就近输出、流式光标只跟随最后一个 text 段。
// v2.1：渲染前经 groupToolSegments 分组（连续只读工具合并为 context-group），
// 正文改走 MarkdownBody 统一入口。
import type { StreamState } from '../../stores/stream.store';
import { groupToolSegments } from '../../lib/group-tool-segments';
import { ThinkingSection } from './ThinkingSection';
import { TodoSection } from './TodoSection';
import { ToolCallChip } from './ToolCallChip';
import { ContextGroupChip } from './ContextGroupChip';
import { MarkdownBody } from './MarkdownBody';

interface Props {
  /** 子 agent 的流式聚合状态（从 streams Map 按 subStreamSessionId 查找后传入） */
  stream: StreamState;
}

export function SubAgentSection({ stream }: Props) {
  const isStreaming = stream.status === 'streaming';

  return (
    // 左边框竖线 + 低对比度底色：视觉上把子 agent 工作区锚定到 dispatch chip 下方
    <div className="my-1 rounded-r-lg border-l-2 border-strong bg-surface-1 py-1 pl-2 pr-2">
      {stream.todos.length > 0 && (
        <TodoSection todos={stream.todos} isStreaming={isStreaming} />
      )}

      {groupToolSegments(stream.segments).map((seg, i, arr) => {
        const isLastSegment = i === arr.length - 1;
        switch (seg.kind) {
          case 'thinking':
            return (
              <ThinkingSection
                key={`sub-think-${i}`}
                content={seg.text}
                isStreaming={isStreaming && isLastSegment}
              />
            );
          case 'tool_call':
            return (
              <ToolCallChip
                key={`sub-tool-${seg.callId}-${i}`}
                toolName={seg.toolName}
                args={seg.args}
                result={seg.result ?? undefined}
                success={seg.success ?? true}
                isExecuting={seg.result === null}
                defaultExpanded={false}
              />
            );
          case 'context-group':
            return <ContextGroupChip key={`sub-ctx-${i}`} group={seg} />;
          case 'text':
            return (
              <div key={`sub-text-${i}`} style={{ marginBottom: 8 }}>
                <MarkdownBody deferHighlight={isStreaming && isLastSegment}>{seg.text}</MarkdownBody>
                {isStreaming && isLastSegment && (
                  <span
                    aria-label="子 agent 流式光标"
                    className="inline-block h-3.5 w-0.5 bg-accent-500 align-text-bottom"
                    style={{
                      marginLeft: 2,
                      // 复用顶层 AgentStreamBubble 定义的 keyframes（嵌套场景下父级一定存在）
                      animation: 'momo-stream-blink 1s infinite',
                    }}
                  />
                )}
              </div>
            );
          case 'dispatch':
            // spec §12：子 agent 不再嵌套委派，防御性忽略
            return null;
        }
      })}
    </div>
  );
}
