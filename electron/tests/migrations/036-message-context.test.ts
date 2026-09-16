// electron/tests/migrations/036-message-context.test.ts
//
// 迁移 v36 测试：messages 表加 context_json 列（nullable TEXT，spec 2026-09-16 §5.3）。
// v2.11 输入框上下文系统：renderer ↔ main 契约载荷（MessageContext 序列化）落库字段。
//
// 三项断言：
//   1. 新列存在（PRAGMA table_info）
//   2. insertMessage 携带 contextJson 落库往返（renderer wire 是 MessageRow 直通，
//      contextJson 不解析，主进程不做变换——schema 加列 + repo 透传即可）
//   3. contextJson 缺省为 null（旧行为兼容——老消息 / 无上下文消息）
//
// fixture 模式：AP_USER_DATA_DIR 临时目录 + runMigrations() 单例（沿用 035 同款），
// insertMessage 用真 getDb() singleton 验证 repo.ts 实际写入路径，不打桩 DB（momo-test-rules）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-mig-036-${Date.now()}`);

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

describe('migration 036 messages.context_json（v2.11 输入框上下文）', () => {
  it('新列存在（PRAGMA table_info 含 context_json）', () => {
    const cols = getDb().prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'context_json')).toBe(true);
  });

  it('insertMessage 携带 contextJson 落库往返', () => {
    const ctx = JSON.stringify({
      skills: [{ slug: 'code-review', name: '代码审查' }],
      files: [{ path: 'src/a.ts' }],
    });
    const row = insertMessage({
      sessionId: 's-mig036',
      sender: 'owner',
      eventType: 'm.room.message',
      body: '检查一下',
      contextJson: ctx,
    });
    expect(row.contextJson).toBe(ctx);
  });

  it('contextJson 缺省为 null（旧行为兼容——旧消息 / 无上下文消息）', () => {
    const row = insertMessage({
      sessionId: 's-mig036',
      sender: 'owner',
      eventType: 'm.room.message',
      body: '普通消息',
    });
    expect(row.contextJson).toBeNull();
  });
});