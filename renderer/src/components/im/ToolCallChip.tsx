// renderer/src/components/im/ToolCallChip.tsx
//
// 工具调用卡片：紧凑一行展示工具名 + 参数摘要 + 状态图标（⏳ 执行中 / ✓ 成功 / ✗ 失败）+ 耗时。
// 点击卡片头部展开/收起详情：参数 JSON 完整结构 + 结果文本（可选）。
// 默认折叠；defaultExpanded 控制初始展开状态。暗色主题兼容。
import { useState } from 'react';

interface Props {
  /** 工具名（如 read_file / dispatch:coder） */
  toolName: string;
  /** 工具入参；摘要取 entries 拼接到 60 字符 */
  args: Record<string, unknown>;
  /** 工具结果文本；undefined 时不渲染结果行 */
  result?: string;
  /** 是否成功（false=失败显示 ✗） */
  success: boolean;
  /** 耗时毫秒；undefined 时不显示耗时 */
  durationMs?: number;
  /** 是否执行中（true 优先显示 ⏳） */
  isExecuting?: boolean;
  /** 初始展开状态（默认 false 折叠） */
  defaultExpanded?: boolean;
}

/** 颜色规范：success=#4ade80, error=#f87171, warning=#fbbf24, neutral=#aaa/#666/#555 */
const STATUS_COLOR = {
  executing: '#fbbf24',
  success: '#4ade80',
  error: '#f87171',
} as const;

const STATUS_BG = {
  executing: 'rgba(251,191,36,0.1)',
  success: 'rgba(74,222,128,0.1)',
  error: 'rgba(248,113,113,0.1)',
} as const;

/** 把参数对象格式化为单行摘要（key: value, ...），最多 60 字符 */
function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
    .slice(0, 60);
}

export function ToolCallChip({
  toolName,
  args,
  result,
  success,
  durationMs,
  isExecuting,
  defaultExpanded,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  // 状态优先级：执行中 > 成功/失败
  const state = isExecuting ? 'executing' : success ? 'success' : 'error';
  const statusIcon = isExecuting ? '⏳' : success ? '✓' : '✗';
  const statusColor = STATUS_COLOR[state];
  const headerBg = STATUS_BG[state];
  const argSummary = summarizeArgs(args);

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderRadius: 4,
          fontSize: 12,
          cursor: 'pointer',
          border: 'none',
          background: headerBg,
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span style={{ color: statusColor }} aria-hidden>
          {statusIcon}
        </span>
        <span style={{ color: '#aaa' }}>{toolName}</span>
        {argSummary && (
          <span style={{ color: '#666', fontSize: 11 }} title={argSummary}>
            {argSummary}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: '#555', fontSize: 11 }}>
          {isExecuting ? '执行中...' : durationMs !== undefined ? `${durationMs}ms` : ''}
        </span>
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 4,
            padding: 8,
            background: 'rgba(0,0,0,0.2)',
            borderRadius: 4,
            fontSize: 11,
            fontFamily: 'monospace',
            color: '#999',
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            maxHeight: 300,
          }}
        >
          <div>参数: {JSON.stringify(args, null, 2)}</div>
          {result !== undefined && (
            <div style={{ marginTop: 4 }}>结果: {result}</div>
          )}
        </div>
      )}
    </div>
  );
}
