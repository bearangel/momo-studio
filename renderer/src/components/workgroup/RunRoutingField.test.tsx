// renderer/src/components/workgroup/RunRoutingField.test.tsx
//
// 「执行位置」三选 radio 卡行（M2.1 T8，视觉合同 S2——.omo/previews/hub-ia-fullapp.html）：
//   - 三态：本机（默认）/ 组内调度（badge 组名，不预演具体节点——简化裁定：
//     「自动选择空闲节点」，避免 renderer 重复调度逻辑）/ 指定节点（高级 + 成员下拉）
//   - 守门降级（Review Focus #1）：未镜像空间 → 仅「本机」+ hint，无灰选项无报错
//   - 批量：label「执行位置（N 个任务统一定）」+ 组内调度 hint 预检行
//     「N 节点在线 · M 已镜像 · 依次派给空闲节点」
//   - 数据失配防御：value 引用的组已不在预检清单 → 回退本机展示，不崩溃
// 纯组件测试：precheck 直注入（IPC 边界由 CreateTaskDialog 层 mock），零 store。
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunRoutingField } from './RunRoutingField';
import type { RoutingPrecheckResult } from '../../ipc/types';

function makePrecheck(overrides: Partial<RoutingPrecheckResult> = {}): RoutingPrecheckResult {
  return {
    mirrored: true,
    groups: [
      {
        groupId: 'g1',
        groupName: 'dev-team',
        onlineCount: 2,
        mirroredCount: 2,
        members: [
          { nodeId: 'node-a', name: 'office-mac', online: true, mirrored: true },
          { nodeId: 'node-b', name: 'lab-node', online: true, mirrored: true },
          { nodeId: 'node-c', name: 'sleepy', online: false, mirrored: false },
        ],
      },
    ],
    ...overrides,
  };
}

describe('RunRoutingField — 三选态', () => {
  it('1. 渲染三行 radio；value=local → 本机选中', () => {
    render(
      <RunRoutingField precheck={makePrecheck()} value={{ mode: 'local' }} onChange={() => {}} />,
    );
    const local = screen.getByRole('radio', { name: '本机执行' });
    const group = screen.getByRole('radio', { name: '组内调度' });
    const node = screen.getByRole('radio', { name: '指定节点' });
    expect(local).toBeChecked();
    expect(group).not.toBeChecked();
    expect(node).not.toBeChecked();
    // 组名 badge（单组：badge 直显组名）
    expect(screen.getByText('dev-team')).toBeInTheDocument();
  });

  it('2. 点组内调度 → onChange({mode:"group", groupId})（单组免选组）', () => {
    const onChange = vi.fn();
    render(<RunRoutingField precheck={makePrecheck()} value={{ mode: 'local' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'group', groupId: 'g1' });
  });

  it('3. 点指定节点 → onChange 锁定首组成员；切成员下拉 → 换 targetNodeId', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RunRoutingField
        precheck={makePrecheck()}
        value={{ mode: 'group', groupId: 'g1' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: '指定节点' }));
    // 首个成员（office-mac / node-a）为默认锁定目标
    expect(onChange).toHaveBeenCalledWith({ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' });

    // 选中指定节点后出现成员下拉；切换 → 新 targetNodeId
    rerender(
      <RunRoutingField
        precheck={makePrecheck()}
        value={{ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('目标成员'), { target: { value: 'node-b' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'node', groupId: 'g1', targetNodeId: 'node-b' });
  });

  it('4. 多组：组内调度行内出现工作组下拉，切组 → onChange 新 groupId', () => {
    const onChange = vi.fn();
    const precheck = makePrecheck({
      groups: [
        ...makePrecheck().groups,
        {
          groupId: 'g2',
          groupName: 'ops-team',
          onlineCount: 1,
          mirroredCount: 1,
          members: [{ nodeId: 'node-x', name: 'box', online: true, mirrored: true }],
        },
      ],
    });
    const { rerender } = render(
      <RunRoutingField precheck={precheck} value={{ mode: 'local' }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: '组内调度' }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'group', groupId: 'g1' });

    rerender(
      <RunRoutingField precheck={precheck} value={{ mode: 'group', groupId: 'g1' }} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('工作组'), { target: { value: 'g2' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'group', groupId: 'g2' });
  });

  it('5. 数据失配防御：value 引用的组已不在预检清单 → 回退本机选中，不崩溃', () => {
    render(
      <RunRoutingField
        precheck={makePrecheck()}
        value={{ mode: 'group', groupId: 'g-gone' }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: '本机执行' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '组内调度' })).not.toBeChecked();
  });
});

describe('RunRoutingField — 守门降级（Review Focus #1）', () => {
  it('6. 未镜像空间：仅「本机」+ hint；组内调度/指定节点不出场（无灰选项、无报错文案）', () => {
    render(
      <RunRoutingField
        precheck={makePrecheck({ mirrored: false, groups: [{ ...makePrecheck().groups[0]!, mirroredCount: 0, members: makePrecheck().groups[0]!.members.map((m) => ({ ...m, mirrored: false })) }] })}
        value={{ mode: 'local' }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: '本机执行' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '组内调度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '指定节点' })).not.toBeInTheDocument();
    expect(screen.getByText(/未镜像到任何工作组/)).toBeInTheDocument();
  });

  it('7. hub 不可达（mirrored 但组清单空）：仅本机 + 不可达 hint（与未镜像区分）', () => {
    render(
      <RunRoutingField precheck={makePrecheck({ groups: [] })} value={{ mode: 'local' }} onChange={() => {}} />,
    );
    expect(screen.queryByRole('radio', { name: '组内调度' })).not.toBeInTheDocument();
    expect(screen.getByText(/工作组不可达/)).toBeInTheDocument();
  });

  it('8. 预检加载中（null）：仅本机 + 检查中 hint，不闪现组行', () => {
    render(<RunRoutingField precheck={null} value={{ mode: 'local' }} onChange={() => {}} />);
    expect(screen.queryByRole('radio', { name: '组内调度' })).not.toBeInTheDocument();
    expect(screen.getByText(/正在检查/)).toBeInTheDocument();
  });
});

describe('RunRoutingField — 批量模式', () => {
  it('9. taskCount=4 → label「执行位置（4 个任务统一定）」；组内调度 hint 含预检行与排队文案', () => {
    render(
      <RunRoutingField
        precheck={makePrecheck()}
        value={{ mode: 'group', groupId: 'g1' }}
        onChange={() => {}}
        taskCount={4}
      />,
    );
    expect(screen.getByText('执行位置（4 个任务统一定）')).toBeInTheDocument();
    expect(screen.getByText(/2 节点在线 · 2 已镜像 · 依次派给空闲节点/)).toBeInTheDocument();
    // 本机批量 hint：按本机并发上限排队
    expect(screen.getByText(/按本机并发上限排队/)).toBeInTheDocument();
  });

  it('10. 单任务（缺省）→ label 无统一定后缀；组内调度 hint 为自动选择文案（不预演节点名）', () => {
    render(
      <RunRoutingField precheck={makePrecheck()} value={{ mode: 'local' }} onChange={() => {}} />,
    );
    expect(screen.queryByText(/统一定/)).not.toBeInTheDocument();
    expect(screen.getByText(/自动选择空闲节点/)).toBeInTheDocument();
    // 简化裁定：不显示具体节点名预演（office-mac 只能作为成员下拉选项出现）
    expect(screen.queryByText(/当前空闲 office-mac/)).not.toBeInTheDocument();
  });
});
