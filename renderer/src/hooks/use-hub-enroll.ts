// renderer/src/hooks/use-hub-enroll.ts
//
// hub 接入表单逻辑 hook（momo-hub M2.1 Task 2 自 HubSettingsPanel.EnrollForm 抽出）：
// 三字段状态 + trim 后经 useHubStore.enroll 提交（IPC 走 ipc.hub.enroll）+ submitting
// 防重 + 错误原文透出（ipc 代理层已剥包装前缀）。
// 供工作组视图空态（WorkgroupEmptyState）就地接入复用；Task 5 收敛时
// HubSettingsPanel 将改用本 hook（本任务不改设置面板，避免任务面扩大）。
import { useState, type FormEvent } from 'react';
import { useHubStore } from '../stores/hub.store';

export function useHubEnroll() {
  const enroll = useHubStore((s) => s.enroll);
  // 换址重接场景预填当前 hubUrl/节点名；未接入初始为空
  const status = useHubStore((s) => s.status);
  const [hubUrl, setHubUrl] = useState(status?.hubUrl ?? '');
  const [nodeName, setNodeName] = useState(status?.nodeName ?? '');
  const [enrollmentToken, setEnrollmentToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await enroll({
        hubUrl: hubUrl.trim(),
        enrollmentToken: enrollmentToken.trim(),
        nodeName: nodeName.trim(),
      });
      // 成功后 store 已覆盖 status → 调用方按 configured 分支切换视图
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return {
    hubUrl,
    setHubUrl,
    nodeName,
    setNodeName,
    enrollmentToken,
    setEnrollmentToken,
    submitting,
    error,
    submit,
  };
}
