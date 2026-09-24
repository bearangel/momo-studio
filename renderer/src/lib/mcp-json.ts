// MCP 服务器 JSON 批量导入解析器（纯函数，McpJsonPasteDialog 消费）。
// P2.4（spec §6.1）：
//   - 顶层三态识别：{ "mcpServers": … }（Claude Desktop/Cursor/Cline）>
//     { "servers": … }（VS Code）> 裸 { <name>: {…} } 对象
//   - 条目 type 权威判定：'sse' 明确报「暂不支持」（D1，不静默误注册）；
//     'http'/'streamable-http'/'streamable_http' 归一远程；'stdio' 本地；
//     缺失时按 url 有无推断（既有语义）
//   - 远程条目支持 headers（Record<string,string> 校验后透传）
// stdio 条目带 headers 静默忽略（仅远程有意义）。

/** 解析后的单条服务器定义（与 RegisterMcpInput 对齐的子集）。url 非空即远程条目。 */
export interface ParsedMcpEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 远程端点（https）；stdio 条目无此字段 */
  url?: string;
  /** 远程条目请求头（P2.4） */
  headers?: Record<string, string>;
}

/** 远程 type 的三种拼写（各家工具不统一，归一处理） */
const REMOTE_TYPE_SPELLINGS: ReadonlySet<string> = new Set(['http', 'streamable-http', 'streamable_http']);

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
  // 三态识别优先级：mcpServers > servers（VS Code）> 裸对象
  const raw = root as Record<string, unknown>;
  const servers =
    raw.mcpServers !== undefined ? raw.mcpServers : raw.servers !== undefined ? raw.servers : root;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error(
      '未找到服务器定义（期望 { "mcpServers": { … } }、VS Code { "servers": { … } } 或裸 { "名称": {…} }）',
    );
  }
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    throw new Error('未找到服务器定义（对象为空）');
  }
  return entries.map(([name, value]) => parseEntry(name, value));
}

/** Record<string,string> 形状校验（env/headers 共用）：非对象或值非字符串 → 中文报错 */
function parseStringRecord(
  field: 'env' | 'headers',
  raw: unknown,
  name: string,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`服务器 "${name}" 的 ${field} 必须是对象`);
  }
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== 'string') throw new Error(`服务器 "${name}" 的 ${field}.${k} 值必须是字符串`);
  }
  return raw as Record<string, string>;
}

/** 解析并校验单条服务器定义 */
function parseEntry(name: string, value: unknown): ParsedMcpEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`服务器 "${name}" 的定义必须是对象`);
  }
  const v = value as Record<string, unknown>;
  const type = typeof v.type === 'string' && v.type !== '' ? v.type : undefined;

  // type 权威判定（spec §6.1）
  if (type === 'sse') {
    throw new Error(`服务器 "${name}"：暂不支持 SSE 传输（仅支持 stdio 本地与 streamable HTTP 远程）`);
  }
  if (type !== undefined && type !== 'stdio' && !REMOTE_TYPE_SPELLINGS.has(type)) {
    throw new Error(`服务器 "${name}" 的 type "${type}" 无法识别（支持 stdio / http）`);
  }
  // 先收窄 url 类型（布尔变量无法让 TS 缓存收窄结果，strict 下需绑定局部值）
  const url = typeof v.url === 'string' ? v.url : '';
  const urlPresent = url !== '';
  const isRemote = type !== undefined ? REMOTE_TYPE_SPELLINGS.has(type) : urlPresent;

  if (isRemote) {
    if (!urlPresent) throw new Error(`服务器 "${name}" 缺少 url 字段（远程条目必填）`);
    if (!url.startsWith('https://')) {
      throw new Error(`服务器 "${name}" 的 url 必须以 https:// 开头（远程 MCP 仅支持 https）`);
    }
    if (typeof v.command === 'string' && v.command.trim() !== '') {
      throw new Error(`服务器 "${name}"：type 为远程但携带 command，请二选一`);
    }
    const entry: ParsedMcpEntry = { name, command: '', url };
    const headers = parseStringRecord('headers', v.headers, name);
    if (headers) entry.headers = headers;
    return entry;
  }

  // 本地 stdio
  if (type === 'stdio' && urlPresent) {
    throw new Error(`服务器 "${name}"：type 为 stdio 但携带 url，请二选一`);
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
  const env = parseStringRecord('env', v.env, name);
  if (env) entry.env = env;
  // stdio 条目带 headers 静默忽略（仅远程有意义）
  return entry;
}
