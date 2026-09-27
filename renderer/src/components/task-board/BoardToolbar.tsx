// renderer/src/components/task-board/BoardToolbar.tsx
//
// 看板工具栏（看板重构 Task 11 建立，spec §5.1）——受控组件，state 全部由
// TaskBoardView 持有：搜索 / 指派人筛选 / 泳道模式开关（Task 12 接线：平铺↔
// 按组分道，偏好持久化在 TaskBoardView）/ 并发徽标（自 TaskBoardView 顶部
// 状态栏迁入，文案格式不变）/ 归档入口（Task 14 接线 ArchivePanel）/
// 新建任务。
import { Archive, Plus, Search } from 'lucide-react';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';

/** assignee 下拉单个选项；label=agentName，value=instanceId（与 task.assigneeAgentId 匹配）。
 *  TaskFilters 退役后迁入（Task 14），类型契约不变。 */
export interface AssigneeOption {
  value: string;
  label: string;
}

/** 并发徽标数据（TaskBoardView 从 tasks + settings 派生后传入） */
export interface BoardConcurrency {
  active: number;
  max: number;
  queued: number;
}

interface BoardToolbarProps {
  text: string;
  onText: (value: string) => void;
  /** 'all' | agentInstanceId */
  assignee: string;
  onAssignee: (value: string) => void;
  /** assignee 下拉选项（父层从 agent.store.members 派生，不含「全部 agent」占位） */
  assigneeOptions: AssigneeOption[];
  laneMode: 'flat' | 'lanes';
  onLaneMode: (mode: 'flat' | 'lanes') => void;
  onOpenArchive: () => void;
  concurrency: BoardConcurrency;
  onCreateTask: () => void;
}

export function BoardToolbar({
  text,
  onText,
  assignee,
  onAssignee,
  assigneeOptions,
  laneMode,
  onLaneMode,
  onOpenArchive,
  concurrency,
  onCreateTask,
}: BoardToolbarProps) {
  return (
    <div className="flex items-center gap-2 border-b border-subtle px-3 py-2">
      {/* 搜索：Search 图标 + Input（label 语义由 aria-label 承担） */}
      <div className="relative">
        <Search
          size={12}
          strokeWidth={1.75}
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-tertiary"
        />
        <Input
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="搜索任务"
          aria-label="搜索任务"
          className="w-44 py-1.5 pl-8"
        />
      </div>
      <Select
        value={assignee}
        onChange={(e) => onAssignee(e.target.value)}
        aria-label="按指派人筛选"
        className="w-32 py-1.5"
      >
        <option value="all">全部 agent</option>
        {assigneeOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
      {/* 泳道模式开关（Task 12 接线）：平铺 ↔ 按组分道 */}
      <button
        type="button"
        role="switch"
        aria-checked={laneMode === 'lanes'}
        title="泳道模式（按分组横向分道）"
        onClick={() => onLaneMode(laneMode === 'flat' ? 'lanes' : 'flat')}
        className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-secondary"
      >
        分组
        <span
          aria-hidden
          className={`inline-block h-3.5 w-6 rounded-full border border-subtle ${
            laneMode === 'lanes' ? 'bg-surface-active' : 'bg-surface-3'
          }`}
        />
      </button>
      {/* 并发徽标：文案格式与迁入前一致（TaskBoardView 既有测试锁死） */}
      <span className="ml-auto shrink-0 text-[11px] text-tertiary">
        并发: {concurrency.active}/{concurrency.max}　排队: {concurrency.queued}
      </span>
      {/* 归档入口：打开 ArchivePanel（Task 14 接线） */}
      <Button variant="secondary" size="sm" onClick={onOpenArchive}>
        <Archive size={12} strokeWidth={1.75} aria-hidden />
        归档
      </Button>
      <Button variant="primary" size="sm" onClick={onCreateTask}>
        <Plus size={12} strokeWidth={1.75} aria-hidden />
        新建任务
      </Button>
    </div>
  );
}
