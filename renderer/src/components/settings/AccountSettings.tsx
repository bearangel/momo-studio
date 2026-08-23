// renderer/src/components/settings/AccountSettings.tsx
// 账户设置：v2.0 会话内核移除 Matrix 登录后为本地单用户应用，
// 此处仅展示结构性 owner 身份（无登录/登出流程）
export function AccountSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg text-neutral-100 mb-4">账户</h2>
        <div className="space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="text-neutral-500 w-20">用户</span>
            <span className="text-neutral-200">owner（本地单用户）</span>
          </div>
        </div>
        <p className="text-xs text-neutral-500 mt-3">
          本应用无登录概念：所有数据存储在本机 SQLite，本地用户消息统一以 owner 身份发送。
        </p>
      </div>
    </div>
  );
}
