// renderer/src/components/settings/AccountSettings.tsx
// 账户设置：显示当前用户信息 + 退出登录按钮
import { useAuthStore } from '../../stores/auth.store';

export function AccountSettings() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg text-neutral-100 mb-4">账户</h2>
        <div className="space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="text-neutral-500 w-20">用户 ID</span>
            <span className="text-neutral-200">{user?.userId ?? '(未知)'}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-neutral-500 w-20">设备 ID</span>
            <span className="text-neutral-200">{user?.deviceId ?? '(未知)'}</span>
          </div>
        </div>
      </div>

      <div className="border-t border-border-subtle pt-4">
        <h3 className="text-sm text-neutral-300 mb-2">退出登录</h3>
        <p className="text-xs text-neutral-500 mb-3">
          退出后需要重新登录才能使用。会话历史不会丢失（存储在 Matrix 服务端）。
        </p>
        <button
          type="button"
          onClick={() => void logout()}
          className="px-4 py-2 text-sm rounded bg-red-600/80 hover:bg-red-600 text-white transition-colors"
        >
          退出登录
        </button>
      </div>
    </div>
  );
}
