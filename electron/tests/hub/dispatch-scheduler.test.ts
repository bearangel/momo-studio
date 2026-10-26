// 组内 least-busy 调度器契约锁（M2.1 T7）——RM-M21-5：无候选返回 null，不轮询。
// 纯函数直跑：零 DB / 零 IPC / 零 mock（mock 收窄铁律——无进程边界可 mock）。
// 契约：候选 = online ∧ mirroredBy.has(nodeId)（mirroredBy 为 T6 登记表查询结果，RM-M21-7）；
// 排序 runningCount 升序 → nodeId 字典序（localeCompare）；负数 runningCount 按 0 处理。
import { describe, expect, it } from 'vitest';
import { pickWorker, type DispatchInput } from '../../src/main/hub/dispatch-scheduler';

/** 构造输入的便捷工厂——仅填选择逻辑消费的字段，契约字段原样透传。 */
function makeInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    groupId: 'group-1',
    workspaceName: 'ws-main',
    members: [],
    mirroredBy: new Set<string>(),
    ...overrides,
  };
}

/** 单个成员速构。 */
function member(nodeId: string, runningCount: number, online = true) {
  return { nodeId, name: `agent@${nodeId}`, online, runningCount };
}

describe('pickWorker — 候选过滤', () => {
  it('1. 单候选命中：唯一在线且已镜像的节点被选中', () => {
    const input = makeInput({
      members: [member('node-a', 3)],
      mirroredBy: new Set(['node-a']),
    });
    expect(pickWorker(input)).toBe('node-a');
  });

  it('4. 离线/未镜像剔除：混入两类干扰项仍选中唯一合格者', () => {
    const input = makeInput({
      members: [
        member('node-offline', 0, false), // 在跑数最少且已镜像，但离线
        member('node-not-mirrored', 1), // 在线，但未镜像
        member('node-ok', 5),
      ],
      mirroredBy: new Set(['node-offline', 'node-ok']),
    });
    expect(pickWorker(input)).toBe('node-ok');
  });

  it('5a. 空成员集 → null（RM-M21-5：不轮询，由待派发卡手动重试）', () => {
    expect(pickWorker(makeInput())).toBeNull();
  });

  it('5b. 全员离线 → null', () => {
    const input = makeInput({
      members: [member('node-a', 0, false), member('node-b', 1, false)],
      mirroredBy: new Set(['node-a', 'node-b']),
    });
    expect(pickWorker(input)).toBeNull();
  });

  it('5c. 全员未镜像 → null', () => {
    const input = makeInput({
      members: [member('node-a', 0), member('node-b', 1)],
      mirroredBy: new Set(),
    });
    expect(pickWorker(input)).toBeNull();
  });
});

describe('pickWorker — least-busy 排序', () => {
  it('2. 多候选 runningCount 最少者胜（与数组顺序无关）', () => {
    const input = makeInput({
      members: [member('node-c', 7), member('node-a', 4), member('node-b', 2)],
      mirroredBy: new Set(['node-a', 'node-b', 'node-c']),
    });
    expect(pickWorker(input)).toBe('node-b');
  });

  it('3. runningCount 平局 → nodeId 字典序稳定（逆序录入仍取字典序最小者）', () => {
    const input = makeInput({
      members: [member('node-z', 2), member('node-m', 2), member('node-a', 2)],
      mirroredBy: new Set(['node-a', 'node-m', 'node-z']),
    });
    expect(pickWorker(input)).toBe('node-a');
  });

  it('附加：runningCount 负数防御——脏计数按 0 处理，与真实 0 平局走字典序', () => {
    // node-dirty(-3) 若按裸数值排序会必胜；按 0 处理后与 node-a(0) 平局，nodeId 定胜
    const input = makeInput({
      members: [member('node-dirty', -3), member('node-a', 0)],
      mirroredBy: new Set(['node-dirty', 'node-a']),
    });
    expect(pickWorker(input)).toBe('node-a');
  });
});

describe('pickWorker — 纯函数不变式', () => {
  it('调用不改变输入（members 数组顺序与内容原样）', () => {
    const members = [member('node-b', 1), member('node-a', 1)];
    const mirroredBy = new Set(['node-a', 'node-b']);
    const input = makeInput({ members, mirroredBy });
    pickWorker(input);
    expect(members).toEqual([member('node-b', 1), member('node-a', 1)]);
    expect(mirroredBy).toEqual(new Set(['node-a', 'node-b']));
  });
});
