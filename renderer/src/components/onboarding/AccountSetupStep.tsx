// renderer/src/components/onboarding/AccountSetupStep.tsx
import { useState, type FormEvent } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/auth.store';

interface Props {
  onNext: () => void;
  onBack: () => void;
}

export function AccountSetupStep({ onNext, onBack }: Props) {
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
      setLocalError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setLocalError('Password must be at least 6 characters');
      return;
    }
    try {
      await register({ username, password });
      onNext();
    } catch {
      // error is in store
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-12 max-w-md mx-auto w-full">
      <h2 className="text-2xl font-bold">Create your account</h2>
      <p className="text-sm text-neutral-400">
        This account is stored locally on the built-in homeserver. No data leaves your machine.
      </p>
      <Input
        label="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        required
      />
      <Input
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        required
      />
      <Input
        label="Confirm password"
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
        <Button variant="ghost" type="button" onClick={onBack}>Back</Button>
        <Button type="submit" disabled={loading || !username}>
          {loading ? 'Creating…' : 'Create account'}
        </Button>
      </div>
    </form>
  );
}