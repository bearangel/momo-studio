// renderer/src/components/resource-library/external-marketplaces.ts
// 外部市场清单常量（P2.3 spec §4）：按资源类型列出可跳转的浏览器市场。
// 缺 url = 预告位（momo-hub 官方统一市场上线前的占位卡，不可点）。
import type { ResourceType } from '../../ipc/types';

export interface MarketplaceLink {
  name: string;
  description: string;
  /** 缺省 = 预告位（不可点） */
  url?: string;
}

export const MARKETPLACES: Record<ResourceType, MarketplaceLink[]> = {
  mcp: [
    { name: 'Smithery', description: '最大的 MCP 服务器注册表', url: 'https://smithery.ai' },
    { name: 'mcp.so', description: '中文友好的 MCP 目录', url: 'https://mcp.so' },
    { name: 'Glama', description: 'MCP 与 agent 工具目录', url: 'https://glama.ai/mcp/servers' },
    { name: 'PulseMCP', description: 'MCP 搜索引擎', url: 'https://www.pulsemcp.com' },
    { name: 'MCP 官方目录', description: 'modelcontextprotocol/servers', url: 'https://github.com/modelcontextprotocol/servers' },
  ],
  skill: [
    { name: 'skills.sh', description: 'Claude 技能市场', url: 'https://skills.sh' },
    { name: 'ClawHub', description: 'clawhub.ai 技能社区', url: 'https://clawhub.ai' },
  ],
  agent: [{ name: 'momo hub', description: '官方统一市场 · 即将上线' }],
};
