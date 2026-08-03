import { useEffect } from 'react';
import { useAuthStore } from './stores/auth.store';
import { useStreamStore } from './stores/stream.store';
import { Onboarding } from './routes/Onboarding';
import { MainShell } from './routes/MainShell';

export function App() {
  const { status, loadCurrent } = useAuthStore();

  useEffect(() => {
    if (status === 'unknown') {
      void loadCurrent();
    }
  }, [status, loadCurrent]);

  // 注册 agent 流式 chunk 监听（应用生命周期内只注册一次；卸载时取消订阅）
  useEffect(() => {
    const unsubscribe = useStreamStore.getState().init();
    return unsubscribe;
  }, []);

  if (status === 'unknown' || status === 'unauthenticated') {
    return <Onboarding onComplete={() => { /* status flips to authenticated */ }} />;
  }

  return <MainShell />;
}