// renderer/src/components/ui/EmptyState.test.tsx
// renderer/src/components/ui/EmptyState.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('渲染图标 / 标题 / 描述 / 动作', () => {
    const { container } = render(
      <EmptyState
        icon={Inbox}
        title="暂无会话"
        description="创建第一个会话开始协作"
        action={<button type="button">新建会话</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: '暂无会话' })).toBeInTheDocument();
    expect(screen.getByText('创建第一个会话开始协作')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建会话' })).toBeInTheDocument();
    // 装饰性图标：lucide svg 默认无 role，brief 预授权使用 querySelector('svg') 兜底
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('description 缺省不渲染', () => {
    render(<EmptyState icon={Inbox} title="空" />);
    expect(screen.queryByText(/。/)).not.toBeInTheDocument();
  });

  it('role 透传：role=status 时可被 role 查询命中', () => {
    render(<EmptyState icon={Inbox} title="空" role="status" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

