import { useEffect } from 'react';
import { useAuthStore } from './stores/auth.store';
import { useStreamStore } from './stores/stream.store';
import { ipc } from './ipc/client';
import { Onboarding } from './routes/Onboarding';
import { MainShell } from './routes/MainShell';

export function App() {
  const { status, loadCurrent } = useAuthStore();

  useEffect(() => {
    if (status === 'unknown') {
      void loadCurrent();
    }
  }, [status, loadCurrent]);

  useEffect(() => {
    const unsubscribe = useStreamStore.getState().init();
    return unsubscribe;
  }, []);

  // v1.5.7: token 失效时跳转登录页
  useEffect(() => {
    const unsubscribe = ipc.auth.onSessionExpired((_reason: string) => {
      useAuthStore.getState().reset();
    });
    return unsubscribe;
  }, []);

  if (status === 'unknown' || status === 'unauthenticated') {
    return <Onboarding onComplete={() => { /* status flips to authenticated */ }} />;
  }

  return <MainShell />;
}