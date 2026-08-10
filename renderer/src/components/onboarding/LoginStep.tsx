// renderer/src/components/onboarding/LoginStep.tsx
import { useState, type FormEvent } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/auth.store';

interface Props {
  onComplete: () => void;
  onSwitchToRegister: () => void;
}

export function LoginStep({ onComplete, onSwitchToRegister }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = useAuthStore((s) => s.login);
  const loading = useAuthStore((s) => s.loading);
  const storeError = useAuthStore((s) => s.error);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login({ username, password });
      onComplete();
    } catch {
      // 错误在 store.error 显示
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-12 max-w-md mx-auto w-full">
      <h2 className="text-2xl font-bold">登录</h2>
      <p className="text-sm text-neutral-400">
        使用你的账号登录。账号存储在本地服务端，数据不会离开你的设备。
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
        autoComplete="current-password"
        required
      />
      {storeError && (
        <div className="text-red-400 text-sm" role="alert">{storeError}</div>
      )}
      <Button type="submit" disabled={loading || !username || !password}>
        {loading ? '登录中…' : '登录'}
      </Button>
      <button
        type="button"
        onClick={onSwitchToRegister}
        className="text-sm text-neutral-400 hover:text-neutral-200 text-center"
      >
        没有账号？点击注册
      </button>
    </form>
  );
}
