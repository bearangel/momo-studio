// electron/tests/hub/delegate-entry-sweep.test.ts
//
// M4.3 入口清单锁（spec §4 风险表「三入口闸遗漏（第四入口?）」）——运行时
// grep sweep：electron/src 内全部 TASK_RPC.delegate 发送点必须落在已知三入口
// 文件，且每个文件携带派发闸单源锚（blockedDispatchError）。第四外派入口
// （新增 hubRequest(TASK_RPC.delegate, …) 调用点）或任一入口闸被移除，本测试
// 即红——强制新入口先过闸再合入。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.join(__dirname, '../../src');

/** 递归收集 .ts 源文件（跳过 .d.ts） */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 字面发送点：直接书写 TASK_RPC.delegate 的文件（相对 electron/src 的 POSIX 路径） */
const LITERAL_SENDERS = new Set([
  'main/hub/dispatch-submit.ts',
  'main/hub/ipc.handlers.ts',
]);

/**
 * ports 消费方：delegation-sync.retryDispatch 经 DispatchSubmitPorts.delegate
 * 间接触达委派管道（不写字面量）——与字面发送点同受闸管制，单独点名锁
 */
const PORTS_CONSUMER = 'main/hub/delegation-sync.ts';

describe('M4.3 外派委派入口清单锁（TASK_RPC.delegate sweep）', () => {
  it('字面发送点全集 = 已知两文件（第四字面入口出现即红）', () => {
    const hits = new Set<string>();
    for (const file of listTsFiles(SRC_ROOT)) {
      if (readFileSync(file, 'utf8').includes('TASK_RPC.delegate')) {
        hits.add(path.relative(SRC_ROOT, file).split(path.sep).join('/'));
      }
    }
    expect(hits).toEqual(LITERAL_SENDERS);
  });

  it('三入口文件全部携带派发闸单源锚 blockedDispatchError（闸移除即红）', () => {
    for (const rel of [...LITERAL_SENDERS, PORTS_CONSUMER]) {
      const src = readFileSync(path.join(SRC_ROOT, rel), 'utf8');
      expect(src, `${rel} 须引用派发闸文案单源`).toContain('blockedDispatchError');
    }
  });
});
