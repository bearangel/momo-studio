import { useEffect } from 'react';
import { useAuthStore } from './stores/auth.store';
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

  // A 子系统：全局 IM 通道订阅（im:message + im:message_event_batch）。
  // subscribeImChannels 内部同时喂 im.store 和 stream.store——同一份 batch 既累积到
  // im.store.eventsByMessage（重启还原用），又聚合到 stream.store.streams（UI 实时渲染用）。
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