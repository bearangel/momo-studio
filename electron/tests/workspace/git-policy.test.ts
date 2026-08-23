// electron/tests/workspace/git-policy.test.ts
//
// 验证 Git Policy CRUD：
//   - getGitPolicy 未配置时返回默认 policy（深拷贝，改返回值不影响下次默认）
//   - setGitPolicy 落库 + getGitPolicy 读回一致
//   - 不同 workspace 隔离
//   - JSON 往返不丢字段（patterns / trailers / 嵌套对象）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  getGitPolicy,
  setGitPolicy,
  defaultGitPolicy,
} from '../../src/main/workspace/git-policy';

const tmpRoot = path.join(os.tmpdir(), `ap-gitpolicy-test-${Date.now()}`);

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

function seedWorkspace(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, team_session_id, owner_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, '测试', '/tmp/test', '!space:localhost', '@alice:localhost');
}

describe('workspace/git-policy', () => {
  it('getGitPolicy 未配置时返回默认 policy', () => {
    seedWorkspace('ws-1');
    const policy = getGitPolicy('ws-1');
    const def = defaultGitPolicy();
    expect(policy.allowAgentCommits).toBe(def.allowAgentCommits);
    expect(policy.defaultBranch).toBe(def.defaultBranch);
    expect(policy.commitMessage.validation).toBe(def.commitMessage.validation);
    expect(policy.commitMessage.patterns).toHaveLength(def.commitMessage.patterns.length);
  });

  it('getGitPolicy 返回默认值的深拷贝（修改不影响下次默认）', () => {
    seedWorkspace('ws-1');
    const a = getGitPolicy('ws-1');
    a.commitMessage.patterns.push({
      code: 'X',
      name: '临时',
      regex: '.*',
      example: 'x',
    });
    a.allowAgentCommits = false;
    const b = getGitPolicy('ws-1');
    // 未 setGitPolicy 落库，第二次读取仍是未被污染的默认值
    expect(b.allowAgentCommits).toBe(true);
    expect(b.commitMessage.patterns).toHaveLength(defaultGitPolicy().commitMessage.patterns.length);
  });

  it('setGitPolicy 落库 + getGitPolicy 读回一致（含嵌套字段）', () => {
    seedWorkspace('ws-1');
    const policy = defaultGitPolicy();
    policy.allowAgentCommits = false;
    policy.commitMessage.validation = 'strict';
    policy.commitMessage.patterns = [
      { code: 'S', name: '故事', regex: '^S\\d+', example: 'S1 描述' },
    ];
    policy.commitMessage.trailers = [{ key: 'Signed-off-by', value: 'agent@x' }];

    setGitPolicy('ws-1', policy);
    const read = getGitPolicy('ws-1');

    expect(read.allowAgentCommits).toBe(false);
    expect(read.commitMessage.validation).toBe('strict');
    expect(read.commitMessage.patterns).toEqual([
      { code: 'S', name: '故事', regex: '^S\\d+', example: 'S1 描述' },
    ]);
    expect(read.commitMessage.trailers).toEqual([{ key: 'Signed-off-by', value: 'agent@x' }]);
  });

  it('不同 workspace 的 policy 互相隔离', () => {
    seedWorkspace('ws-1');
    seedWorkspace('ws-2');
    const p1 = defaultGitPolicy();
    p1.defaultBranch = 'develop';
    setGitPolicy('ws-1', p1);

    expect(getGitPolicy('ws-1').defaultBranch).toBe('develop');
    // ws-2 未配置，仍为默认 main
    expect(getGitPolicy('ws-2').defaultBranch).toBe('main');
  });
});
