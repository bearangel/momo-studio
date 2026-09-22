// MCP 服务器 JSON 批量导入解析器（纯函数，McpJsonPasteDialog 消费）。
// 接受两种输入：
//   1. 标准 { "mcpServers": { <name>: { command, args?, env? } } } 包裹结构
//   2. 裸 { <name>: { command, ... } } 对象
// 条目二态（P2 起）：stdio（command 启动）或远程（url 连接，强制 https）。
// url 非空即按远程条目解析（command 置空串占位），非 https url 抛错。

/** 解析后的单条服务器定义（与 RegisterMcpInput 对齐的子集）。url 非空即远程条目。 */
export interface ParsedMcpEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 远程端点（https）；stdio 条目无此字段 */
  url?: string;
}

/** 解析文本为服务器列表。任何格式错误抛中文 Error（含条目名/字段名）。 */
export function parseMcpServersJson(text: string): ParsedMcpEntry[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('内容不是合法 JSON');
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('根必须是 JSON 对象');
  }
  // mcpServers 包裹优先；无包裹键则把整个对象当服务器表
  const raw = root as Record<string, unknown>;
  const servers = (raw.mcpServers !== undefined ? raw.mcpServers : root) as Record<string, unknown>;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error('未找到服务器定义（期望 { "mcpServers": { ... } } 或裸 { "名称": {...} }）');
  }
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    throw new Error('未找到服务器定义（对象为空）');
  }
  return entries.map(([name, value]) => parseEntry(name, value));
}

/** 解析并校验单条服务器定义 */
function parseEntry(name: string, value: unknown): ParsedMcpEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`服务器 "${name}" 的定义必须是对象`);
  }
  const v = value as Record<string, unknown>;
  // url 型远程条目：非空 url 即视为远程（P2 转正）。强制 https 前缀——
  // 与主进程 registerMcpDefinition 的注册校验同口径（http 明文会暴露 token/会话数据）
  if (typeof v.url === 'string' && v.url !== '') {
    if (!v.url.startsWith('https://')) {
      throw new Error(`服务器 "${name}" 的 url 必须以 https:// 开头（远程 MCP 仅支持 https）`);
    }
    return { name, command: '', url: v.url };
  }
  if (typeof v.command !== 'string' || v.command.trim() === '') {
    throw new Error(`服务器 "${name}" 缺少 command 字段`);
  }
  const entry: ParsedMcpEntry = { name, command: v.command };
  if (v.args !== undefined) {
    if (!Array.isArray(v.args) || v.args.some((a) => typeof a !== 'string')) {
      throw new Error(`服务器 "${name}" 的 args 必须是字符串数组`);
    }
    entry.args = v.args as string[];
  }
  if (v.env !== undefined) {
    if (typeof v.env !== 'object' || v.env === null || Array.isArray(v.env)) {
      throw new Error(`服务器 "${name}" 的 env 必须是对象`);
    }
    for (const [k, val] of Object.entries(v.env as Record<string, unknown>)) {
      if (typeof val !== 'string') throw new Error(`服务器 "${name}" 的 env.${k} 值必须是字符串`);
    }
    entry.env = v.env as Record<string, string>;
  }
  return entry;
}
