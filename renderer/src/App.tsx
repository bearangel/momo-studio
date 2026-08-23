import { useEffect } from 'react';
import { useAuthStore } from './stores/auth.store';
import { ipc } from './ipc/client';
import { subscribeSessionChannels } from './stores/session.store';
import { Onboarding } from './routes/Onboarding';
import { MainShell } from './routes/MainShell';

export function App() {
  const { status, loadCurrent } = useAuthStore();

  useEffect(() => {
    if (status === 'unknown') {
      void loadCurrent();
    }
  }, [status, loadCurrent]);

  // 全局会话通道订阅（session:message + session:message_event_batch；
  // preload 反向桥让 im:message 发送方也走同一回调）。
  // subscribeSessionChannels 内部同时喂 session.store 和 stream.store——同一份 batch
  // 既累积到 session.store.eventsByMessage（重启还原用），又聚合到
  // stream.store.streams（UI 实时渲染用）。
  // 放在 App 顶层保证整个生命周期只订阅一次，避免视图切换重复注册。
  useEffect(() => {
    const unsubscribe = subscribeSessionChannels();
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