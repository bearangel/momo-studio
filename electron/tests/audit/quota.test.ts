// electron/tests/audit/quota.test.ts
//
// 验证审计容量滚动删除：
//   - estimateAuditBytes 字节数公式：textSum + rowCount × 400（行开销常数）
//   - resolveAuditQuotaMb 优先级：workspaces.audit_quota_mb > global_settings.auditQuotaMb > 100
//   - setAuditQuota：写入 / null 清除回全局 / 非正数拒绝 / workspace 不存在拒绝
//   - getAuditQuotaInfo：{ quotaMb, usedBytes, rowCount }
//   - enforceAuditQuota：超限时按批次删最旧直至 ≤ quota×0.95（滞回）；
//     占用在 95%–100% 区间不触发（防抖动）；默认批次 5000（LIMIT 截断可观察）
//
// 行字节构成：400 + len(agent)+len(tool)+len(input)+len(output)。
// 测试用 inputSummary/outputSummary 各 500 字符的行（单行 1402 字节），
// 通过小 batchSize 精确验证循环与停止条件。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import {
  estimateAuditBytes,
  resolveAuditQuotaMb,
  setAuditQuota,
  getAuditQuotaInfo,
  enforceAuditQuota,
} from '../../src/main/audit/quota';

const tmpRoot = path.join(os.tmpdir(), `ap-audit-quota-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 直插 workspace 行（绕过 crud 层的 git init 等副作用） */
function createWorkspace(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, 'n', '', '/tmp/w', 0, 'owner', '📁')`,
    )
    .run(id);
}

const T500 = 'x'.repeat(500);

/** 直插一条 1402 字节的审计行（400 + 1 + 1 + 500 + 500），ts 唯一递增保证删除顺序确定。
 *  id 带 workspace 前缀——tool_calls 主键全局唯一，跨 ws 的用例不能撞号。 */
function insertRow(id: number, workspaceId: string, heavy = true): void {
  const ts = new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString().slice(0, 19).replace('T', ' ');
  getDb()
    .prepare(
      `INSERT INTO tool_calls
         (id, workspace_id, agent_bot_user_id, task_id, tool_name, input_summary, output_summary, success, duration_ms, timestamp)
       VALUES (?, ?, 'a', NULL, 't', ?, ?, 1, 1, ?)`,
    )
    .run(`${workspaceId}-row-${id}`, workspaceId, heavy ? T500 : '', heavy ? T500 : '', ts);
}

/** 事务内批量插入，避免 WAL 下逐条 fsync 拖慢测试 */
function insertRows(count: number, workspaceId: string, startId = 0): void {
  const db = getDb();
  const run = db.transaction((n: number, base: number) => {
    for (let i = 0; i < n; i++) insertRow(base + i, workspaceId);
  });
  run(count, startId);
}

function rowCount(workspaceId: string): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE workspace_id = ?').get(workspaceId) as { n: number }
  ).n;
}

const MB = 1024 * 1024;
/** 单行 1402 字节 */
const ROW_BYTES = 400 + 1 + 1 + 500 + 500;

describe('audit/quota — estimateAuditBytes', () => {
  it('空 workspace 估 0 字节', () => {
    expect(estimateAuditBytes('ws-none')).toBe(0);
  });

  it('公式 = 文本列长度和 + 行数 × 400', () => {
    // 行 1：agent '@bot:a'(6) + tool 'read_file'(9) + in '你好'(2 字符) + out ''(0) → 文本 17
    getDb()
      .prepare(
        `INSERT INTO tool_calls (id, workspace_id, agent_bot_user_id, tool_name, input_summary, output_summary, timestamp)
         VALUES ('r1', 'ws-1', '@bot:a', 'read_file', '你好', '', '2026-01-01 00:00:00')`,
      )
      .run();
    // 行 2：agent 'b'(1) + tool 't'(1) + in 'abc'(3) + out 'de'(2) → 文本 7
    getDb()
      .prepare(
        `INSERT INTO tool_calls (id, workspace_id, agent_bot_user_id, tool_name, input_summary, output_summary, timestamp)
         VALUES ('r2', 'ws-1', 'b', 't', 'abc', 'de', '2026-01-02 00:00:00')`,
      )
      .run();

    expect(estimateAuditBytes('ws-1')).toBe((17 + 7) + 2 * 400);
  });

  it('按 workspace 隔离——只统计本 workspace 行', () => {
    insertRows(3, 'ws-1');
    insertRows(5, 'ws-2');
    expect(estimateAuditBytes('ws-1')).toBe(3 * ROW_BYTES);
    expect(estimateAuditBytes('ws-2')).toBe(5 * ROW_BYTES);
  });
});

describe('audit/quota — 配额解析与设置', () => {
  it('默认 100MB：workspace 无覆盖且全局无配置', () => {
    createWorkspace('ws-a');
    expect(resolveAuditQuotaMb('ws-a')).toBe(100);
  });

  it('全局配置生效：global_settings.auditQuotaMb 覆盖默认', () => {
    createWorkspace('ws-a');
    updateGlobalSettings({ auditQuotaMb: 50 });
    expect(resolveAuditQuotaMb('ws-a')).toBe(50);
  });

  it('workspace 覆盖优先于全局', () => {
    createWorkspace('ws-a');
    createWorkspace('ws-b');
    updateGlobalSettings({ auditQuotaMb: 50 });
    setAuditQuota('ws-b', 2);
    expect(resolveAuditQuotaMb('ws-a')).toBe(50);
    expect(resolveAuditQuotaMb('ws-b')).toBe(2);
  });

  it('setAuditQuota null 清除覆盖，回退全局', () => {
    createWorkspace('ws-a');
    updateGlobalSettings({ auditQuotaMb: 50 });
    setAuditQuota('ws-a', 3);
    expect(resolveAuditQuotaMb('ws-a')).toBe(3);
    setAuditQuota('ws-a', null);
    expect(resolveAuditQuotaMb('ws-a')).toBe(50);
  });

  it('setAuditQuota 拒绝非正数', () => {
    createWorkspace('ws-a');
    expect(() => setAuditQuota('ws-a', 0)).toThrow();
    expect(() => setAuditQuota('ws-a', -5)).toThrow();
    expect(() => setAuditQuota('ws-a', Number.NaN)).toThrow();
  });

  it('setAuditQuota 拒绝不存在的 workspace', () => {
    expect(() => setAuditQuota('ws-ghost', 5)).toThrow();
  });

  it('getAuditQuotaInfo 返回 { quotaMb, usedBytes, rowCount }', () => {
    createWorkspace('ws-a');
    setAuditQuota('ws-a', 7);
    insertRows(3, 'ws-a');
    const info = getAuditQuotaInfo('ws-a');
    expect(info.quotaMb).toBe(7);
    expect(info.usedBytes).toBe(3 * ROW_BYTES);
    expect(info.rowCount).toBe(3);
  });
});

describe('audit/quota — enforceAuditQuota 滚动删除', () => {
  it('占用未超限 → 不删任何行，返回 0', () => {
    createWorkspace('ws-a');
    setAuditQuota('ws-a', 1);
    insertRows(100, 'ws-a'); // 140,200 B < 1MB
    expect(enforceAuditQuota('ws-a', 100)).toBe(0);
    expect(rowCount('ws-a')).toBe(100);
  });

  it('滞回区间（95%–100% 配额）不触发删除', () => {
    createWorkspace('ws-a');
    setAuditQuota('ws-a', 1); // 1,048,576 B；95% = 996,147.2 B
    // 711 行 = 996,822 B：≤ 配额但 > 95% 线。正确语义是"超限(>100%)才触发"，
    // 故不应删除；若实现误为">95% 即触发"则此用例失败（防抖动回归锁）。
    insertRows(711, 'ws-a');
    expect(enforceAuditQuota('ws-a', 100)).toBe(0);
    expect(rowCount('ws-a')).toBe(711);
  });

  it('超限 → 按批次删最旧直至 ≤ 95% 配额（而非仅回到 100%），返回删除数', () => {
    createWorkspace('ws-a');
    setAuditQuota('ws-a', 1); // target = 996,147.2 B
    insertRows(1400, 'ws-a'); // 1,962,800 B 超限
    const deleted = enforceAuditQuota('ws-a', 20); // 每批 20 行
    // 95% 停止线 ≈ 710.6 行；批步长 20 从 1400 递减只能落在 720→700：
    // 720 行 = 1,009,440 仍超线 → 再删一批 → 700 行 = 981,400 ≤ 线停。
    // 若只回到 100%（≤1,048,576）会停在 740 行——本用例锁 95% 滞回语义。
    expect(deleted).toBe(700);
    expect(rowCount('ws-a')).toBe(700);
    expect(estimateAuditBytes('ws-a')).toBeLessThanOrEqual(Math.floor(0.95 * MB));
    // 删的是最旧：幸存行最小序号 = 700（timestamp 升序删除）
    const minId = Math.min(
      ...(
        getDb()
          .prepare('SELECT id FROM tool_calls WHERE workspace_id = ?')
          .all('ws-a') as { id: string }[]
      ).map((r) => Number(r.id.split('-').pop())),
    );
    expect(minId).toBe(700);
  });

  it('enforce 遵循配额优先级：workspace 覆盖(2MB)放过、全局(1MB)拦截', () => {
    createWorkspace('ws-override');
    createWorkspace('ws-global');
    updateGlobalSettings({ auditQuotaMb: 1 });
    setAuditQuota('ws-override', 2);
    // 各 800 行 = 1,121,600 B：> 1MB（触发 ws-global），≤ 2MB（放过 ws-override）
    insertRows(800, 'ws-override');
    insertRows(800, 'ws-global');

    expect(enforceAuditQuota('ws-override', 100)).toBe(0);
    expect(rowCount('ws-override')).toBe(800);

    expect(enforceAuditQuota('ws-global', 100)).toBeGreaterThan(0);
    expect(estimateAuditBytes('ws-global')).toBeLessThanOrEqual(Math.floor(0.95 * MB));
  });

  it('默认批次 5000——单条 DELETE 截断 5000 行（剩余 1000 行可观察）', () => {
    createWorkspace('ws-a');
    setAuditQuota('ws-a', 2); // 2,097,152 B；target ≈ 1,992,294 B
    insertRows(6000, 'ws-a'); // 8,412,000 B 超限
    const deleted = enforceAuditQuota('ws-a'); // 默认 batchSize 5000
    // 首批 LIMIT 5000 删掉 row-0..4999 → 剩 1000 行 = 1,402,000 B ≤ target 停止。
    // 若无 LIMIT 截断，首条 DELETE 会清空全部 6000 行（剩 0）。
    expect(deleted).toBe(5000);
    expect(rowCount('ws-a')).toBe(1000);
  });

  it('删除不影响其他 workspace 的行', () => {
    createWorkspace('ws-a');
    createWorkspace('ws-b');
    setAuditQuota('ws-a', 1);
    insertRows(1000, 'ws-a');
    insertRows(10, 'ws-b');
    enforceAuditQuota('ws-a', 100);
    expect(rowCount('ws-b')).toBe(10);
  });
});
