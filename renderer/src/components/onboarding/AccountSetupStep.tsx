import { useState, type FormEvent } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/auth.store';

interface Props {
  onNext: () => void;
  onBack: () => void;
  onSwitchToLogin: () => void;
}

export function AccountSetupStep({ onNext, onBack, onSwitchToLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const register = useAuthStore((s) => s.register);
  const loading = useAuthStore((s) => s.loading);
  const storeError = useAuthStore((s) => s.error);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (password !== confirm) {
      setLocalError('两次输入的密码不一致');
      return;
    }
    if (password.length < 6) {
      setLocalError('密码至少 6 位');
      return;
    }
    try {
      await register({ username, password });
      onNext();
    } catch {
      // 错误在 store.error 显示
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-12 max-w-md mx-auto w-full">
      <h2 className="text-2xl font-bold">创建账号</h2>
      <p className="text-sm text-neutral-400">
        账号存储在本地内置服务端，数据不会离开你的设备。
      </p>
      <Input
        label="用户名"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        required
      />
      <Input
        label="密码"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        required
      />
      <Input
        label="确认密码"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        required
      />
      {(localError ?? storeError) && (
        <div className="text-red-400 text-sm" role="alert">{localError ?? storeError}</div>
      )}
      <div className="flex gap-3 justify-end">
        <Button variant="ghost" type="button" onClick={onBack}>返回</Button>
        <Button type="submit" disabled={loading || !username}>
          {loading ? '创建中…' : '创建账号'}
        </Button>
      </div>
      <button
        type="button"
        onClick={onSwitchToLogin}
        className="text-sm text-neutral-400 hover:text-neutral-200 text-center"
      >
        已有账号？点击登录
      </button>
    </form>
  );
}
