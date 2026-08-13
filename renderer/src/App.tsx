import { useEffect } from 'react';
import { useAuthStore } from './stores/auth.store';
import { useStreamStore } from './stores/stream.store';
import { ipc } from './ipc/client';
import { subscribeImChannels } from './stores/im.store';
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

  // A 子系统：全局 IM 通道订阅（im:message + im:message_event_batch）。
  // 放在 App 顶层保证整个生命周期只订阅一次，避免视图切换重复注册。
  useEffect(() => {
    const unsubscribe = subscribeImChannels();
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