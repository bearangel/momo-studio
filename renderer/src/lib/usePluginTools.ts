// renderer/src/lib/usePluginTools.ts
//
// 插件工具清单 hook（工作空间维度 v1.1 spec §7.3）：数据来自 IPC
// plugin:listAssembledTools（主进程装配面派生）。失败置 error 不抛出——
// 消费方（DefinitionEditor 插件工具分组）降级为不渲染分组，不阻塞表单。
import { useEffect, useState } from 'react';
import { ipc } from '../ipc/client';
import type { PluginToolInfo } from '../ipc/types';

export function usePluginTools(workspaceId: string | null): { data: PluginToolInfo[] | null; error: string | null } {
  const [data, setData] = useState<PluginToolInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (workspaceId === null) {
      setData(null);
      return;
    }
    setData(null);
    setError(null);
    ipc.plugin
      .listAssembledTools(workspaceId)
      .then((tools) => {
        if (alive) setData(tools);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  return { data, error };
}
