// electron/src/main/agent/mcp-bridge.ts
//
// 子进程 → 主进程的 MCP IPC 桥（Task 13 自 runtime-entry.ts 迁出）。
// MCP Host 运行在主进程，agent 子进程通过 process.send/on('message') 请求
// 工具发现与调用，按随机 id 配对响应。工具名格式 mcp:<server>:<tool>。

import { randomUUID } from 'node:crypto';
import type { LLMToolDef } from './llm-provider';
import type { McpToolInfo } from '../mcp/types';
import type { RuntimeConfig } from './runtime-config';

/** 单次 MCP IPC 调用的超时时间（毫秒） */
const MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * 请求主进程列出某 MCP server 暴露的工具（启动时发现工具定义用）。
 * 通过 process.send 发送 mcp:listTools，监听 process('message') 等待配对响应。
 */
function requestMcpListTools(workspaceId: string, mcpName: string): Promise<McpToolInfo[]> {
  return new Promise<McpToolInfo[]>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('MCP 工具发现不可用：子进程未建立 IPC 通道'));
      return;
    }
    const id = randomId();
    const timer = setTimeout(() => {
      process.off('message', handler);
      reject(new Error(`MCP ${mcpName} 工具发现超时（${MCP_CALL_TIMEOUT_MS / 1000}s）`));
    }, MCP_CALL_TIMEOUT_MS);
    const handler = (msg: unknown): void => {
      const m = msg as {
        type?: string;
        id?: string;
        tools?: McpToolInfo[];
        error?: string;
      };
      if (m.id !== id) return;
      process.off('message', handler);
      clearTimeout(timer);
      if (m.error !== undefined) {
        reject(new Error(m.error));
      } else {
        resolve(m.tools ?? []);
      }
    };
    process.on('message', handler);
    process.send({ type: 'mcp:listTools', id, workspaceId, mcpName });
  });
}

/** 请求主进程调用某 MCP 工具；语义同 requestMcpListTools 但走 mcp:callTool 通道 */
export function requestMcpCall(
  workspaceId: string,
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('MCP 调用不可用：子进程未建立 IPC 通道'));
      return;
    }
    const id = randomId();
    const timer = setTimeout(() => {
      process.off('message', handler);
      reject(new Error(`MCP ${mcpName}.${toolName} 调用超时（${MCP_CALL_TIMEOUT_MS / 1000}s）`));
    }, MCP_CALL_TIMEOUT_MS);
    const handler = (msg: unknown): void => {
      const m = msg as { type?: string; id?: string; result?: string; error?: string };
      if (m.id !== id) return;
      process.off('message', handler);
      clearTimeout(timer);
      if (m.error !== undefined) {
        reject(new Error(m.error));
      } else {
        resolve(m.result ?? '');
      }
    };
    process.on('message', handler);
    process.send({ type: 'mcp:callTool', id, workspaceId, mcpName, toolName, args });
  });
}

/**
 * 启动时发现全部配置 MCP server 的工具定义，转为 LLMToolDef（name 格式 mcp:<server>:<tool>）。
 * 单个 MCP 发现失败只记录日志并跳过，不阻塞 agent 上线。
 */
export async function discoverMcpTools(config: RuntimeConfig): Promise<LLMToolDef[]> {
  const defs: LLMToolDef[] = [];
  for (const mcpName of config.mcpNames) {
    try {
      const tools = await requestMcpListTools(config.workspaceId, mcpName);
      for (const t of tools) {
        defs.push({
          name: `mcp:${mcpName}:${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    } catch (err) {
      process.stderr.write(
        `MCP ${mcpName} 工具发现失败（已跳过）: ${(err as Error).message}\n`,
      );
    }
  }
  return defs;
}

/** 生成短随机 id，用于 IPC 请求/响应配对 */
function randomId(): string {
  return randomUUID().slice(0, 8);
}
