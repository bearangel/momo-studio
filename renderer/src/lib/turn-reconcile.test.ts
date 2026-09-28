// renderer/src/lib/turn-reconcile.test.ts
//
// 任务回合对账 renderer 侧测试（turn reconciliation spec 2026-09-28 §3.5/§3.6）：
//   - 模板镜像同步锁：runtime-entry.ts 全模块过重不宜直接 import（board-columns
//     直引先例只适用于轻量模块）——按 tokens.test.ts 既有先例走文件读取 +
//     正则提取 electron 常量文本，双侧逐字比对（spec 回归锁清单 #5）
//   - 派生谓词矩阵：in_progress+无活跃流 / 流式中 / completed / 无执行会话
//   - todo 源收集：最新带 todos 的流聚合、滤 completed、无源 → null
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ImMessage } from '../ipc/types';
import {
  TURN_RECONCILE_NOTICE_PREFIX,
  buildTurnReconcileNotice,
  collectOpenTodoItems,
  derivePendingWrapUp,
  sessionHasRunningTurn,
} from './turn-reconcile';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronRuntimeEntry = readFileSync(
  path.join(here, '../../../electron/src/main/agent/runtime-entry.ts'),
  'utf-8',
);

/** spec §3.2 逐字模板（带未清项）——renderer 镜像与 electron 源双侧锁同一份文本 */
const EXPECTED_WITH_ITEMS = `${TURN_RECONCILE_NOTICE_PREFIX}（非新任务请求）：任务 T-9 仍处于 in_progress，待办存在未清项：
  - 修复登录（进行中）
  - 补充测试（待处理）
请二选一：
(a) 完成剩余项，调用 todowrite 如实更新，并调用 complete_task 关闭任务；
(b) 确认剩余项不应/不能现在完成：调用 todowrite 如实更新状态，在终文中说明原因，
    任务保持 in_progress 留待用户处理。
严禁重复执行已完成的事项。本提醒一次性，不会再触发。`;

/** spec §3.2 空列表降级分支（闭合言语行为缺失单独触发） */
const EXPECTED_EMPTY_ITEMS = `${TURN_RECONCILE_NOTICE_PREFIX}（非新任务请求）：任务 T-9 仍处于 in_progress，待办存在未清项：
  （无未清待办——但任务尚未调用 complete_task / fail_task 关闭）
请二选一：
(a) 完成剩余项，调用 todowrite 如实更新，并调用 complete_task 关闭任务；
(b) 确认剩余项不应/不能现在完成：调用 todowrite 如实更新状态，在终文中说明原因，
    任务保持 in_progress 留待用户处理。
严禁重复执行已完成的事项。本提醒一次性，不会再触发。`;

describe('催收尾模板镜像同步（renderer ↔ electron runtime-entry）', () => {
  it('前缀常量与 electron 源正则提取值逐字相等', () => {
    const m = electronRuntimeEntry.match(
      /export const TURN_RECONCILE_NOTICE_PREFIX = '([^']+)';/,
    );
    expect(m).not.toBeNull();
    expect(TURN_RECONCILE_NOTICE_PREFIX).toBe(m![1]);
  });

  it('带未清项：renderer 镜像输出 = spec §3.2 逐字模板', () => {
    expect(
      buildTurnReconcileNotice('T-9', [
        { subject: '修复登录', status: 'in_progress' },
        { subject: '补充测试', status: 'pending' },
      ]),
    ).toBe(EXPECTED_WITH_ITEMS);
  });

  it('空列表：降级为闭合缺失占位行（spec §3.1 分支）', () => {
    expect(buildTurnReconcileNotice('T-9', [])).toBe(EXPECTED_EMPTY_ITEMS);
  });

  it('electron 源包含拼出同一文本的全部字面片段（措辞漂移即红）', () => {
    expect(electronRuntimeEntry).toContain(
      '（非新任务请求）：任务 ${taskId} 仍处于 in_progress，待办存在未清项：',
    );
    expect(electronRuntimeEntry).toContain("'请二选一：\\n'");
    expect(electronRuntimeEntry).toContain(
      "'(a) 完成剩余项，调用 todowrite 如实更新，并调用 complete_task 关闭任务；\\n'",
    );
    expect(electronRuntimeEntry).toContain(
      "'(b) 确认剩余项不应/不能现在完成：调用 todowrite 如实更新状态，在终文中说明原因，\\n'",
    );
    expect(electronRuntimeEntry).toContain("'    任务保持 in_progress 留待用户处理。\\n'");
    expect(electronRuntimeEntry).toContain(
      "'严禁重复执行已完成的事项。本提醒一次性，不会再触发。'",
    );
    expect(electronRuntimeEntry).toContain(
      "'  （无未清待办——但任务尚未调用 complete_task / fail_task 关闭）'",
    );
    expect(electronRuntimeEntry).toContain('`  - ${t.subject}（${TODO_STATUS_LABEL[t.status]}）`');
    expect(electronRuntimeEntry).toContain("pending: '待处理'");
    expect(electronRuntimeEntry).toContain("in_progress: '进行中'");
    expect(electronRuntimeEntry).toContain("completed: '已完成'");
  });
});

describe('derivePendingWrapUp 派生矩阵（spec §3.5）', () => {
  const inProgress = { status: 'in_progress' as const, executionSessionId: 'sess-1' };

  it('in_progress + 宿主会话无运行回合 → 显示（重启后仅凭 in_progress 亦成立）', () => {
    expect(derivePendingWrapUp(inProgress, false)).toBe(true);
  });

  it('会话正在流式输出 → 不显示', () => {
    expect(derivePendingWrapUp(inProgress, true)).toBe(false);
  });

  it('completed → 不显示（终态）', () => {
    expect(
      derivePendingWrapUp({ status: 'completed', executionSessionId: 'sess-1' }, false),
    ).toBe(false);
  });

  it('无 executionSessionId 的 in_progress → 不显示（语义边界）', () => {
    expect(derivePendingWrapUp({ status: 'in_progress', executionSessionId: null }, false)).toBe(
      false,
    );
  });
});

describe('sessionHasRunningTurn / collectOpenTodoItems', () => {
  const mkMsg = (id: string): ImMessage => ({
    id,
    sessionId: 'sess-1',
    sender: '@bot:x',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: null,
    taskId: null,
    contextJson: null,
    createdAt: 0,
    updatedAt: 0,
  });

  it('任一消息流聚合 streaming → 有运行回合；全终态/无消息 → 无', () => {
    const msgs = [mkMsg('m1'), mkMsg('m2')];
    const streaming = new Map([['m2', { status: 'streaming' as const }]]);
    const done = new Map([['m2', { status: 'done' as const }]]);
    expect(sessionHasRunningTurn(msgs, streaming)).toBe(true);
    expect(sessionHasRunningTurn(msgs, done)).toBe(false);
    expect(sessionHasRunningTurn(undefined, streaming)).toBe(false);
    expect(sessionHasRunningTurn([], streaming)).toBe(false);
  });

  it('collectOpenTodoItems：取最新带 todos 的流聚合并滤出未清项', () => {
    const msgs = [mkMsg('m-old'), mkMsg('m-new')];
    const streams = new Map([
      [
        'm-old',
        {
          todos: [
            { id: 't1', subject: '旧项', status: 'completed' as const },
            { id: 't2', subject: '旧未清', status: 'pending' as const },
          ],
        },
      ],
      [
        'm-new',
        {
          todos: [
            { id: 't3', subject: '修复登录', status: 'in_progress' as const },
            { id: 't4', subject: '收尾', status: 'completed' as const },
          ],
        },
      ],
    ]);
    expect(collectOpenTodoItems(msgs, streams)).toEqual([
      { subject: '修复登录', status: 'in_progress' },
    ]);
  });

  it('collectOpenTodoItems：无 todo 源（消息未加载 / 流聚合无 todos）→ null（错误路径）', () => {
    expect(collectOpenTodoItems(undefined, new Map())).toBeNull();
    expect(collectOpenTodoItems([mkMsg('m1')], new Map())).toBeNull();
  });
});
