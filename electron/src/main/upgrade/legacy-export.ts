// electron/src/main/upgrade/legacy-export.ts
//
// v1.x 旧库数据导出（P5 Task 1）。
// 旧列名以 migrations v1-v22 源码为唯一事实：
//   - messages（v17 建，v23 前列名）：id / room_id / sender / event_type / body / created_at
//   - agent_definitions（v3 建立后以下列从未改名）：name / slug / system_prompt /
//     icon_emoji / description / default_tools / source
// 会话正文复用 im/markdown-exporter 的 formatRoomToMarkdown（签名兼容：旧行可无损映射
// 为 ExportMessage，content 置空对象、botName 置 null），保证导出格式与 2.0 会话导出一致。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DBType } from 'better-sqlite3';
import { formatRoomToMarkdown } from '../im/markdown-exporter';
import type { ExportMessage, ExportMeta } from '../im/markdown-exporter';

export interface LegacyExportResult {
  sessionCount: number;
  agentDefCount: number;
}

interface LegacyMessageRow {
  id: string;
  room_id: string;
  sender: string;
  event_type: string;
  body: string;
  created_at: number;
}

interface LegacyAgentDefRow {
  name: string;
  slug: string;
  system_prompt: string;
  icon_emoji: string;
  description: string;
  default_tools: string;
  source: string;
}

interface AgentDefinitionExport extends LegacyAgentDefRow {
  /** default_tools 列的 JSON 解析结果；解析失败时回退为原始字符串 */
  default_tools_parsed: unknown;
}

function tableExists(db: DBType, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/** Matrix room id（如 !room-alpha:localhost）→ 文件名安全字符（! : 等被折叠为 _） */
function sanitizeRoomFileToken(roomId: string): string {
  const token = roomId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return token.length > 0 ? token : 'room';
}

function parseJsonOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function toExportMessage(r: LegacyMessageRow): ExportMessage {
  return {
    eventId: r.id,
    roomId: r.room_id,
    sender: r.sender,
    body: r.body,
    eventType: r.event_type,
    content: {},
    timestamp: r.created_at,
    botName: null,
  };
}

/**
 * 只读导出旧库数据到 outDir：
 *   - sessions/<room_id 安全化>.md：按 room_id 分组，仅 m.room.message，
 *     头部含 room_id 原值 / 条数 / 时间跨度（formatRoomToMarkdown 元信息）
 *   - agent-definitions.json：{ meta, agents }（数组 + meta）
 * 表不存在（如 v1/v2 期极老库无 messages 表）→ 对应计数为 0，不抛错。
 * 连接在本函数内打开并关闭，调用方无需善后。
 */
export function exportLegacyData(dbPath: string, outDir: string): LegacyExportResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    fs.mkdirSync(path.join(outDir, 'sessions'), { recursive: true });

    let sessionCount = 0;
    if (tableExists(db, 'messages')) {
      const rows = db
        .prepare(
          `SELECT id, room_id, sender, event_type, body, created_at
           FROM messages
           WHERE event_type = 'm.room.message'
           ORDER BY room_id, created_at`,
        )
        .all() as LegacyMessageRow[];

      // ORDER BY room_id 保证同房间行连续；碰撞的安全化名字追加 -2/-3 去重
      const usedNames = new Map<string, number>();
      let currentRoom: string | null = null;
      let buffer: LegacyMessageRow[] = [];

      const flushRoom = (): void => {
        if (currentRoom === null || buffer.length === 0) return;
        const base = sanitizeRoomFileToken(currentRoom);
        const seen = usedNames.get(base) ?? 0;
        usedNames.set(base, seen + 1);
        const fileName = seen === 0 ? `${base}.md` : `${base}-${seen + 1}.md`;

        const meta: ExportMeta = {
          // v1.x rooms 表已随 Matrix 消亡不可考，房间名统一标注为旧版会话
          roomName: '旧版会话',
          roomId: currentRoom,
          exportedAt: new Date(),
          requestedLimit: buffer.length,
          actualCount: buffer.length,
        };
        const markdown = formatRoomToMarkdown(buffer.map(toExportMessage), meta);
        fs.writeFileSync(path.join(outDir, 'sessions', fileName), markdown, 'utf-8');
        sessionCount += 1;
        buffer = [];
      };

      for (const row of rows) {
        if (row.room_id !== currentRoom) {
          flushRoom();
          currentRoom = row.room_id;
        }
        buffer.push(row);
      }
      flushRoom();
    }

    let agentDefCount = 0;
    if (tableExists(db, 'agent_definitions')) {
      const defs = db
        .prepare(
          `SELECT name, slug, system_prompt, icon_emoji, description, default_tools, source
           FROM agent_definitions`,
        )
        .all() as LegacyAgentDefRow[];
      agentDefCount = defs.length;

      const payload: { meta: Record<string, unknown>; agents: AgentDefinitionExport[] } = {
        meta: {
          exportedAt: new Date().toISOString(),
          source: 'v1.x legacy state.db',
          count: defs.length,
        },
        agents: defs.map((d) => ({ ...d, default_tools_parsed: parseJsonOrRaw(d.default_tools) })),
      };
      fs.writeFileSync(
        path.join(outDir, 'agent-definitions.json'),
        JSON.stringify(payload, null, 2),
        'utf-8',
      );
    }

    return { sessionCount, agentDefCount };
  } finally {
    db.close();
  }
}
