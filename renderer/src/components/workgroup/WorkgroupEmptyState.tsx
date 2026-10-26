// renderer/src/components/workgroup/WorkgroupEmptyState.tsx
//
// 工作组视图未接入空态（momo-hub M2.1 Task 2）——视觉合同
// .omo/previews/hub-ia-fullapp.html §S3 暗黑屏定值逐项落码：
// - 居中布局 gap 12px；Users 图标 30px / strokeWidth 1.75 / tertiary
// - 标题「尚未接入工作组网络」14px / 600 / primary（text-sm font-semibold）
// - 说明 max-width 340px 居中 tertiary；按钮组「接入 hub」primary +「什么是工作组？」
// 「接入 hub」→ 就地三字段接入表单（逻辑复用 useHubEnroll）；「什么是工作组？」
// 切换帮助文案（非死入口）。
import { useState } from 'react';
import { Users } from 'lucide-react';
import { useHubEnroll } from '../../hooks/use-hub-enroll';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export function WorkgroupEmptyState() {
  const [formOpen, setFormOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const form = useHubEnroll();

  if (formOpen) {
    return (
      <div className="flex flex-1 items-center justify-center bg-canvas">
        <form
          className="flex w-full max-w-[340px] flex-col gap-3"
          aria-label="接入 hub"
          onSubmit={(e) => void form.submit(e)}
        >
          <Input
            label="hub 地址"
            className="w-full font-mono text-[12.5px]"
            value={form.hubUrl}
            onChange={(e) => form.setHubUrl(e.target.value)}
            placeholder="https://hub.example.com:8787"
          />
          <Input
            label="节点名"
            className="w-full"
            value={form.nodeName}
            onChange={(e) => form.setNodeName(e.target.value)}
            placeholder="办公室 MacBook"
          />
          <Input
            label="加入凭证"
            type="password"
            className="w-full font-mono text-[12.5px]"
            value={form.enrollmentToken}
            onChange={(e) => form.setEnrollmentToken(e.target.value)}
            placeholder="join-xxxx-xxxx"
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={form.submitting}>
              接入
            </Button>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              取消
            </Button>
          </div>
          {form.error !== null && (
            <p className="text-xs text-status-error" role="alert">
              {form.error}
            </p>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-3 text-center">
        <Users size={30} strokeWidth={1.75} aria-hidden className="text-tertiary" />
        <div className="text-sm font-semibold text-primary">尚未接入工作组网络</div>
        <p className="max-w-[340px] text-[11px] leading-relaxed text-tertiary">
          接入 hub 后，这里显示你的工作组、成员在线态与跨节点任务调度。新设备可直接接入，无需先创建工作空间。
        </p>
        {helpOpen && (
          <p className="max-w-[340px] text-xs leading-relaxed text-tertiary">
            工作组是跨设备节点编队：成员节点互为镜像与调度目标，看板任务可选「组内调度」由空闲节点执行，leader 可只读查看成员工作空间。
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={() => setFormOpen(true)}>接入 hub</Button>
          <Button variant="secondary" onClick={() => setHelpOpen((v) => !v)}>
            什么是工作组？
          </Button>
        </div>
      </div>
    </div>
  );
}
