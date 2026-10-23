// HubManager 单例——主进程生命周期接线（taskExecutor 同款模块级单例模式）。
// 职责：读配置+凭证 → 起停 HubClient；状态/事件转发全部窗口（webContents.send）。
import { BrowserWindow } from 'electron';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { createHubClient, enrollOverHttp, type HubClient, type HubConnectionState } from './client';
import { createHubConfigStore, type HubConfigRow } from './config-store';
import { clearDeviceToken, getDeviceToken, setDeviceToken } from './creds';
import { EVT, type EventEnvelope } from './protocol';

export interface HubStatus {
  configured: boolean;
  state: HubConnectionState;
  hubUrl: string | null;
  nodeName: string | null;
  nodeId: string | null;
  lastError: string | null;
}

let client: HubClient | null = null;
let lastError: string | null = null;

const configStore = () => createHubConfigStore(getDb());

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export function hubGetStatus(): HubStatus {
  const cfg = configStore().read();
  return {
    configured: cfg !== null,
    state: client?.state() ?? 'disconnected',
    hubUrl: cfg?.hubUrl ?? null,
    nodeName: cfg?.nodeName ?? null,
    nodeId: cfg?.nodeId ?? null,
    lastError,
  };
}

function startClient(hubUrl: string, nodeName: string, deviceToken: string): void {
  client?.stop();
  client = createHubClient({
    url: wsUrlOf(hubUrl),
    nodeName,
    deviceToken,
    onStateChange(state, err) {
      if (err) lastError = err;
      if (state === 'online') lastError = null;
      broadcast('hub:stateChanged', { state, lastError });
    },
    onEvent(evt: EventEnvelope) {
      if (evt.method === EVT.nodeOnline) {
        broadcast('hub:nodePresence', { kind: 'online', ...(evt.payload as { nodeId: string; nodeName: string }) });
      } else if (evt.method === EVT.nodeOffline) {
        broadcast('hub:nodePresence', { kind: 'offline', ...(evt.payload as { nodeId: string }) });
      }
    },
  });
  client.start();
}

/** hubUrl（http/https origin）→ ws/wss URL + /ws 路径。 */
function wsUrlOf(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

function normUrl(hubUrl: string): string { return hubUrl.trim().replace(/\/$/, ''); }

/** app ready 后调用：已配置且有凭证则自动连接。 */
export async function initHub(): Promise<void> {
  const cfg = configStore().read();
  if (!cfg) return;
  const token = await getDeviceToken();
  if (!token) { logger.warn('hub 已配置但 keychain 无 device token（跳过连接）'); return; }
  startClient(cfg.hubUrl, cfg.nodeName, token);
}

export async function hubConfigure(input: { hubUrl: string; nodeName: string }): Promise<HubStatus> {
  const store = configStore();
  const prev: HubConfigRow | null = store.read();
  store.write({ hubUrl: normUrl(input.hubUrl), nodeName: input.nodeName.trim(), nodeId: prev?.nodeId ?? null });
  await initHub();
  return hubGetStatus();
}

export async function hubEnroll(input: { hubUrl: string; enrollmentToken: string; nodeName: string }): Promise<HubStatus> {
  const hubUrl = normUrl(input.hubUrl);
  const nodeName = input.nodeName.trim();
  const r = await enrollOverHttp(hubUrl, input.enrollmentToken, nodeName);
  await setDeviceToken(r.deviceToken);
  configStore().write({ hubUrl, nodeName, nodeId: r.nodeId });
  startClient(hubUrl, nodeName, r.deviceToken);
  return hubGetStatus();
}

export async function hubForget(): Promise<void> {
  client?.stop();
  client = null;
  configStore().clear();
  await clearDeviceToken();
  broadcast('hub:stateChanged', { state: 'disconnected', lastError: null });
}

/** before-quit 调用。 */
export function stopHub(): void {
  client?.stop();
  client = null;
}
