// renderer/src/components/im/DispatchChip.tsx
//
// dispatch 委派 chip（v1.4）：紧凑头行展示子 agent 的委派状态，点击展开/折叠
// 嵌套的 SubAgentSection（子 agent 的思考 + 工具 + 正文）。
//
// 状态映射（status → icon/text/color）：
//   queued     ⏳ 排队    #888（灰）
//   executing  ⏳ 执行中  #fbbf24（黄）
//   completed  ✅ 完成    #4ade80（绿）
//   failed     ❌ 失败    #f87171（红）
//   aborted    ⏹ 已中断  #fbbf24（黄）——用户停止后由聚合层终态收敛产生
//
// 自动展开/折叠（useEffect 监听 child.status）：
//   - executing / failed → 默认展开（让用户看到实时进度 / 错误细节）
//   - completed / queued  → 默认折叠（减少视觉噪音）
//   - 一旦用户手动点击 toggle，停止自动行为（userToggled 标志）
//
// 展开且传入 subStream 时渲染 <SubAgentSection stream={subStream} />。
import { useEffect, useState } from 'react';
import type { StreamState } from '../../stores/stream.store';
import { SubAgentSection } from './SubAgentSection';

/**
 * dispatch chip 内的子 agent 委派状态。
 *
 * v2.0 A 子系统：从 stream.store 移到 DispatchChip 本地定义（stream.store 重写后
 * 不再 export DispatchChild）。字段与 AggregatedDispatch 子集对齐（A9 完整重写后
 * 可直接复用 AggregatedDispatch）。
 */
export interface DispatchChild {
  subStreamSessionId: string;
  subAgentName: string;
  subAgentAvatar?: string;
  status: 'queued' | 'executing' | 'completed' | 'failed' | 'aborted';
}

interface DispatchChipProps {
  /** 子 agent 委派状态（来自父 stream 的 dispatches，由调用方映射为 DispatchChild） */
  child: DispatchChild;
  /** 子 agent 的流式聚合状态（可能尚未到达；按 subStreamSessionId 反查子消息后聚合） */
  subStream?: StreamState;
}

/** status → 展示配置（图标 + 文案 + 颜色） */
const STATUS_CONFIG: Record<
  DispatchChild['status'],
  { icon: string; text: string; color: string }
> = {
  queued: { icon: '⏳', text: '排队', color: '#888' },
  executing: { icon: '⏳', text: '执行中', color: '#fbbf24' },
  completed: { icon: '✅', text: '完成', color: '#4ade80' },
  failed: { icon: '❌', text: '失败', color: '#f87171' },
  aborted: { icon: '⏹', text: '已中断', color: '#fbbf24' },
};

/** 各状态的自动展开默认值（用户未手动 toggle 前） */
const AUTO_EXPANDED: Record<DispatchChild['status'], boolean> = {
  executing: true,
  failed: true,
  completed: false,
  queued: false,
  aborted: false,
};

/**
 * 从子 agent 流的最后一个内容段推导当前活动提示。
 * 无 subStream（派单与子 agent 首个 start chunk 之间的空窗）→「已派出，等待启动…」。
 */
function deriveActivity(subStream: StreamState | undefined): string | null {
  if (!subStream) return '已派出，等待启动…';
  const last = subStream.segments[subStream.segments.length - 1];
  if (!last) return '已启动…';
  switch (last.kind) {
    case 'thinking':
      return '💭 思考中…';
    case 'tool_call':
      return last.result === null ? `🔧 ${last.toolName}` : `🔧 ${last.toolName} ✓`;
    case 'text':
      return '✍️ 输出中…';
    case 'dispatch':
      return null;
  }
}

/** 每秒跳动的耗时显示（executing 期间；完成/失败后由调用方卸载） */
function ElapsedTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const text = seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
  return <span style={{ color: '#666' }}>⏱ {text}</span>;
}

export function DispatchChip({ child, subStream }: DispatchChipProps) {
  const config = STATUS_CONFIG[child.status];
  const avatar = child.subAgentAvatar ?? '🤖';
  const isBusy = child.status === 'executing' || child.status === 'queued';
  const activity = isBusy ? deriveActivity(subStream) : null;
  const timerSince = isBusy && subStream ? subStream.startedAt : null;

  // 初始展开状态由 status 决定（首次渲染即生效）
  const [expanded, setExpanded] = useState(() => AUTO_EXPANDED[child.status]);
  // 用户是否手动 toggle 过——一旦为 true，不再跟随 status 自动展开/折叠
  const [userToggled, setUserToggled] = useState(false);

  // 监听 status 变化：未手动 toggle 时，按 status 默认值同步展开状态
  useEffect(() => {
    if (!userToggled) {
      setExpanded(AUTO_EXPANDED[child.status]);
    }
  }, [child.status, userToggled]);

  const handleToggle = () => {
    setUserToggled(true);
    setExpanded((prev) => !prev);
  };

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={handleToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderRadius: 4,
          fontSize: 12,
          cursor: 'pointer',
          border: '1px solid #444',
          background: 'rgba(0,0,0,0.2)',
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span aria-hidden>📤</span>
        <span aria-hidden>{avatar}</span>
        <span style={{ color: '#ccc' }}>{child.subAgentName}</span>
        {/* 状态图标 + 文案合并到一个带颜色的 span（便于测试断言颜色） */}
        <span style={{ color: config.color }}>{`${config.icon} ${config.text}`}</span>
        {activity && (
          <span style={{ color: '#999', fontSize: 11 }} data-testid="dispatch-activity">
            {activity}
          </span>
        )}
        {timerSince !== null && <ElapsedTimer since={timerSince} />}
        <span style={{ marginLeft: 'auto', color: '#666' }} aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && subStream && <SubAgentSection stream={subStream} />}
    </div>
  );
}
