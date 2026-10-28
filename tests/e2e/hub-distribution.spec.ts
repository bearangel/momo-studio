// tests/e2e/hub-distribution.spec.ts
//
// M2.3 Task 7（P3-4）——hub 分发链 / readonly 即时拒 / 版本链 回归沉淀 e2e。
//
// 被测链路（六场景）：
//   1. 发布→记账：custom skill 经资源库「发布到 hub」→ hub multipart 收包 →
//      installed_packages 落 `hub:{slug}` 记账 → 资源库 hub 页签已装角标
//      （v{version} · 已是最新——发布记账 M2.2 §2.1 四类泛化 + D7 锚点）
//   2. manifest 携带：镜像向导 S2 构建+上传 → 快照 manifest.resources 携带已发布
//      skill（记账反查，UC-P1-3 分发闭环裁定）→ S2「Skill 清单（补装 + 内嵌）」
//      计数 1 补装 + 0 内嵌
//   3. 全新 profile 零 unresolved：隔离 userData 的第二实例收 mirror.apply →
//      先装后落（installResources 补装 skill）→ 回执 appliedResources 含
//      skill/{slug} 且 unresolvedRefs 无任何 skill:* 条目
//   4. readonly 即时拒：task.assigned{permissionTier:'readonly'} → mock LLM 驱动
//      bash 写工作空间外 → seatbelt 拦截 → write-blocked 漏斗即时 denied
//      （task.report 进度拍 kind='denied'，excerpt 含「只读档位即时拒绝」）
//   5. 版本链 v1→v2 前进：目录 latest（hub v0.1.5 = versions semver max）→
//      resource.published 事件驱动「可更新」角标 → 更新走 fresh 目录 → v2 下载
//      安装记账（T2 语义：compareVersions 前进才装）
//   6. 已是最新如实报：同版再装 → installHubPackage 返回 alreadyLatest:true
//      零动作（无第二次下载——不谎报已更新）
//
// 环境（零外网零 sibling 仓——studio 消费端点逐一 mock，单端口）：
//   - mock hub（node:http + ws）：
//       POST /enroll                              → {nodeId, deviceToken}
//       WS   /ws                                  → hello/ping/group.*/task.* RPC 应答
//                                                 + resource.published/task.assigned 下发
//                                                 + mirror.apply 定向 req（收 mirror.receipt res）
//                                                 + task.report res 捕获（id=taskId）
//       GET  /resources/catalog                   → HubCatalog（latest=semver max、versions 降序）
//       POST /resources/publish                   → multipart(manifest+package) 收包即记 201
//       GET  /resources/{slug}/{version}/download → 归档字节（计数按 slug@version）
//       POST /workspaces/snapshots                → multipart(manifest+payload) 201
//       GET  /workspaces/snapshots/{id}/download  → payload + X-Checksum-Sha256
//   - mock LLM：POST /v1/chat/completions——OpenAI 兼容；stream:true 走 SSE
//     （可编排 tool_calls/final），非流式返回 JSON（会话命名等杂项调用）。
//     provider 行 baseUrl 指向本服务（llm-provider 既有缝——产品侧零改动）。
//
// 运行（同既有 e2e 惯例，需先 build 双 workspace + electron-rebuild ABI）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3 -w keytar
//   npx pnpm@9.0.0 e2e tests/e2e/hub-distribution.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const electronRequire = createRequire(path.join(__dirname, '..', '..', 'electron', 'package.json'));
const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

// ──────────────────────────────────────────────────────────────────────────
// 常量与临时目录
// ──────────────────────────────────────────────────────────────────────────

const WS_NAME = 'e2e-hub-dist-ws';
const SKILL_SLUG = 'e2e-hub-dist-skill';
const SKILL_PUBLISH_VERSION = '1.0.1';
const CHAIN_SLUG = 'chain-skill';
const TASK_ID = 'task-e2e-readonly';
const MIRROR_ID = 'mirror-e2e-1';
const ENROLL_TOKEN = 'join-e2e-token';

const runId = `${Date.now()}-${process.pid}`;
const tmpRoot = path.join(os.tmpdir(), `momo-hub-dist-e2e-${runId}`);
const userA = path.join(tmpRoot, 'profile-a');
const userB = path.join(tmpRoot, 'profile-b');
const wsDirA = path.join(tmpRoot, 'ws-a');
const denyFile = path.join(os.homedir(), `momo-e2e-hub-deny-${runId}.txt`);

// ──────────────────────────────────────────────────────────────────────────
// mock hub / mock LLM 状态
// ──────────────────────────────────────────────────────────────────────────

/** 单版本记录（publish 收包 / 预种子共用） */
interface VersionRec {
  version: string;
  manifest: Record<string, unknown>;
  bytes: Buffer;
  checksum: string;
  sizeBytes: number;
  publishedAt: number;
}

interface WsLike {
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** 宽松 semver 比较（数值段 + 缺段按 0——version-compare 同语义子集） */
function semverCompare(a: string, b: string): number {
  const seg = (v: string, i: number): number => {
    const s = v.split('+', 1)[0]!.split('.')[i];
    return s !== undefined && /^[0-9]+$/.test(s) ? Number(s) : 0;
  };
  const len = Math.max(a.split('.').length, b.split('.').length);
  for (let i = 0; i < len; i += 1) {
    const d = seg(a, i) - seg(b, i);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const hub = {
  server: null as HttpServer | null,
  baseUrl: '',
  /** slug → 资源（type + 全版本） */
  resources: new Map<string, { type: string; versions: Map<string, VersionRec> }>(),
  /** snapshotId → 存档 */
  snapshots: new Map<string, { bytes: Buffer; checksum: string; workspaceName: string }>(),
  /** POST /resources/publish 收包记录（manifest part 解析面） */
  publishRequests: [] as Array<{ slug: string; type: string; version: string; author: string }>,
  /** POST /workspaces/snapshots 收包记录 */
  snapshotUploads: [] as Array<{ workspaceName: string; version: string; resources: number }>,
  /** 下载计数：`${slug}@${version}` → 次数 */
  downloads: new Map<string, number>(),
  /** task.report 上报捕获：taskId → payloads */
  taskReports: new Map<string, Array<{ status: string; progress?: { kind?: string; excerpt?: string } }>>(),
  /** mirror.apply 回执捕获：mirrorId(=req id) → {ok, payload} */
  mirrorReceipts: new Map<string, { ok: boolean; payload: Record<string, unknown> }>(),
  /** 已定向下发的 mirror.apply req id 集（res 回捕对账） */
  pendingMirrors: new Set<string>(),
  /** 工作组账本（group.create/list 消费） */
  groups: [] as Array<{
    groupId: string; groupName: string; leaderNodeId: string;
    members: Array<{ nodeId: string; name: string; online: boolean }>;
  }>,
  /** deviceToken → 节点 */
  nodes: new Map<string, { nodeId: string; nodeName: string }>(),
  /** nodeId → 活跃 ws 连接（定向下发面） */
  conns: new Map<string, WsLike>(),
  allSockets: new Set<WsLike>(),
  /** mock LLM：SSE 剧本（'deny-write' | 'final-text'，消费即清） */
  llmScript: [] as Array<'deny-write' | 'final-text'>,
};

function downloadCount(slug: string, version: string): number {
  return hub.downloads.get(`${slug}@${version}`) ?? 0;
}

/** hub 侧登记一个资源版本（预种子 / 用例内升版共用；broadcast=true 时向全部在线节点发 resource.published） */
function hubPublishVersion(rec: {
  slug: string; type: string; name: string; version: string; author: string;
  description: string; readme: string; tags: string[]; category: string; iconEmoji: string;
  bytes: Buffer;
}, broadcast: boolean): void {
  const entry = hub.resources.get(rec.slug) ?? { type: rec.type, versions: new Map<string, VersionRec>() };
  const manifest: Record<string, unknown> = {
    slug: rec.slug, type: rec.type, name: rec.name, version: rec.version, author: rec.author,
    description: rec.description, readme: rec.readme, tags: rec.tags, category: rec.category,
    iconEmoji: rec.iconEmoji, verificationStatus: 'unverified',
  };
  entry.versions.set(rec.version, {
    version: rec.version,
    manifest,
    bytes: rec.bytes,
    checksum: crypto.createHash('sha256').update(rec.bytes).digest('hex'),
    sizeBytes: rec.bytes.length,
    publishedAt: Date.now(),
  });
  hub.resources.set(rec.slug, entry);
  if (!broadcast) return;
  broadcastEvt('resource.published', {
    slug: rec.slug, type: rec.type, name: rec.name, version: rec.version, author: rec.author, at: Date.now(),
  });
}

/** 目录装配：latest = versions 全集 semver max（hub v0.1.5 语义），versions 降序 */
function buildCatalog(): Record<string, unknown> {
  const items = [...hub.resources.entries()].map(([slug, entry]) => {
    const versions = [...entry.versions.values()].sort((a, b) => semverCompare(b.version, a.version));
    const latest = versions[0]!;
    const m = latest.manifest as Record<string, string>;
    return {
      slug,
      type: entry.type,
      name: m.name,
      version: latest.version,
      author: m.author,
      description: m.description,
      readme: m.readme,
      tags: latest.manifest.tags as string[],
      category: m.category,
      iconEmoji: m.iconEmoji,
      verificationStatus: 'unverified',
      downloadUrl: `/resources/${encodeURIComponent(slug)}/${encodeURIComponent(latest.version)}/download`,
      checksum: latest.checksum,
      sizeBytes: latest.sizeBytes,
      publishedAt: latest.publishedAt,
      versions: versions.map((v) => v.version),
    };
  });
  return { version: '1', updatedAt: new Date().toISOString(), items };
}

function broadcastEvt(method: string, payload: unknown): void {
  const env = JSON.stringify({ v: 1, kind: 'evt', method, payload });
  for (const sock of hub.allSockets) {
    try { sock.send(env); } catch { /* 连接半关——忽略 */ }
  }
}

function sendToNode(nodeId: string, env: Record<string, unknown>): boolean {
  const sock = hub.conns.get(nodeId);
  if (!sock) return false;
  try { sock.send(JSON.stringify(env)); return true; } catch { return false; }
}

/** multipart/form-data 手工解析（undici FormData 产出形态：\r\n 分隔 + boundary） */
function parseMultipart(body: Buffer, contentType: string): Array<{ name: string; filename?: string; data: Buffer }> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (m?.[1] ?? m?.[2])?.trim();
  if (boundary === undefined || boundary === '') return [];
  const delim = Buffer.from(`--${boundary}`);
  const parts: Array<{ name: string; filename?: string; data: Buffer }> = [];
  let start = body.indexOf(delim);
  while (start !== -1) {
    const next = body.indexOf(delim, start + delim.length);
    if (next === -1) break;
    let seg = body.subarray(start + delim.length, next);
    if (seg.length >= 2 && seg[0] === 13 && seg[1] === 10) seg = seg.subarray(2);
    if (seg.length >= 2 && seg[seg.length - 2] === 13 && seg[seg.length - 1] === 10) {
      seg = seg.subarray(0, seg.length - 2);
    }
    const headerEnd = seg.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = seg.subarray(0, headerEnd).toString('utf-8');
      const nameMatch = /name="([^"]*)"/.exec(headerText);
      const fileMatch = /filename="([^"]*)"/.exec(headerText);
      if (nameMatch?.[1] !== undefined) {
        parts.push({ name: nameMatch[1], filename: fileMatch?.[1], data: seg.subarray(headerEnd + 4) });
      }
    }
    start = next;
  }
  return parts;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function bearerNode(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  return hub.nodes.get(auth.slice('Bearer '.length))?.nodeId ?? null;
}

/** skill 归档构造（tar.gz，SKILL.md 在根——installPackage 解压即注册面） */
async function buildSkillArchive(slug: string, version: string): Promise<Buffer> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `momo-hub-e2e-${slug}-`));
  try {
    fs.writeFileSync(
      path.join(stage, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: ${slug} e2e fixture\nversion: ${version}\n---\n\n# ${slug} ${version}\n\nhub distribution e2e fixture.\n`,
    );
    const archive = path.join(stage, 'pkg.tar.gz');
    await execFileAsync('tar', ['czf', archive, '-C', stage, 'SKILL.md']);
    return fs.readFileSync(archive);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** WS req 应答（同 id res 信封） */
function replyReq(sock: WsLike, req: { id: string; method: string }, ok: boolean, payload: unknown): void {
  sock.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, method: req.method, ok, payload }));
}

/** mock hub WS 消息面：req（hello/ping/组/委派对账）+ res（task.report / mirror.receipt 捕获） */
function handleWsMessage(sock: WsLike, raw: unknown, selfNodeId: string): void {
  let env: { kind?: string; id?: string; method?: string; ok?: boolean; payload?: unknown };
  try {
    env = JSON.parse(String(raw)) as { kind?: string; id?: string; method?: string; ok?: boolean; payload?: unknown };
  } catch {
    return;
  }

  // ── res 信封：studio 主动上行面（task.report；mirror.apply 的回执）──
  if (env.kind === 'res' && typeof env.id === 'string' && typeof env.method === 'string') {
    if (env.method === 'task.report') {
      const payload = (env.payload ?? {}) as { status?: string; progress?: { kind?: string; excerpt?: string } };
      const q = hub.taskReports.get(env.id) ?? [];
      q.push({ status: payload.status ?? 'unknown', progress: payload.progress });
      hub.taskReports.set(env.id, q);
      return;
    }
    if (hub.pendingMirrors.has(env.id)) {
      hub.pendingMirrors.delete(env.id);
      hub.mirrorReceipts.set(env.id, { ok: env.ok === true, payload: (env.payload ?? {}) as Record<string, unknown> });
      return;
    }
    return;
  }

  if (env.kind !== 'req' || typeof env.method !== 'string') return;
  const req = { id: env.id ?? '', method: env.method };
  const payload = (env.payload ?? {}) as Record<string, unknown>;

  switch (env.method) {
    case 'hello':
      replyReq(sock, req, true, {
        hubId: 'e2e-hub-mock', protoVer: '1.2.0', serverTime: Date.now(), onlineNodes: [],
      });
      return;
    case 'ping':
      replyReq(sock, req, true, { ts: (payload as { ts?: number }).ts ?? Date.now(), serverTime: Date.now() });
      return;
    case 'group.create': {
      const groupName = String(payload.groupName ?? 'e2e 组');
      const groupId = `g-e2e-${hub.groups.length + 1}`;
      const node = selfNodeId !== '' ? [...hub.nodes.values()].find((n) => n.nodeId === selfNodeId) : undefined;
      hub.groups.push({
        groupId,
        groupName,
        leaderNodeId: selfNodeId,
        members: [{ nodeId: selfNodeId, name: node?.nodeName ?? selfNodeId, online: true }],
      });
      replyReq(sock, req, true, { groupId, nodeId: selfNodeId });
      return;
    }
    case 'group.list':
      replyReq(sock, req, true, { groups: hub.groups });
      return;
    case 'group.invite':
      replyReq(sock, req, true, { inviteCode: 'e2e-invite' });
      return;
    case 'group.leave':
    case 'group.transfer':
      replyReq(sock, req, true, { ok: true });
      return;
    case 'task.list':
      replyReq(sock, req, true, { tasks: [] });
      return;
    case 'task.delegate':
      replyReq(sock, req, true, { taskId: `task-hub-${Date.now()}` });
      return;
    case 'task.cancel':
      replyReq(sock, req, true, { ok: true });
      return;
    default:
      // view.consent 等其余方法——ok 容忍（协议未知容忍语义）
      replyReq(sock, req, true, { ok: true });
      return;
  }
}

/** 起 mock hub（HTTP 数据面 + /ws 控制面 + mock LLM 同端口） */
async function startMockHub(): Promise<void> {
  const { WebSocketServer } = electronRequire('ws') as {
    WebSocketServer: new (opts: { noServer: boolean }) => {
      on(event: 'connection', cb: (sock: WsLike, req: IncomingMessage) => void): void;
      handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer, cb: (sock: WsLike) => void): void;
    };
  };
  const wss = new WebSocketServer({ noServer: true });
  let nodeSeq = 0;

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0]!;
    const method = req.method ?? 'GET';

    // ---- mock LLM（OpenAI 兼容；provider baseUrl 指向 {hub}/v1）----
    if (url === '/v1/chat/completions' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf-8')) as { stream?: boolean };
      if (body.stream !== true) {
        // 非流式（会话命名等杂项）——极简 JSON
        sendJson(res, 200, { choices: [{ message: { content: '委派任务' }, finish_reason: 'stop' }] });
        return;
      }
      const step = hub.llmScript.shift();
      let chunks: Array<Record<string, unknown>>;
      if (step === 'deny-write') {
        const args = JSON.stringify({ command: `touch '${denyFile}'` });
        chunks = [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e2e_deny', function: { name: 'bash', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ];
      } else {
        chunks = [
          { choices: [{ delta: { content: '已按只读约束处理，任务结束。' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      // final 延迟 1500ms——保证 denied 进度拍先于回合终态上报（runner tick 500ms 合并窗）
      const delay = step === 'final-text' ? 1500 : 0;
      setTimeout(() => {
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, delay);
      return;
    }

    // ---- enroll（无鉴权）----
    if (url === '/enroll' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf-8')) as { nodeName?: string };
      nodeSeq += 1;
      const nodeId = `node-e2e-${nodeSeq}`;
      const deviceToken = `tok-e2e-${nodeSeq}`;
      hub.nodes.set(deviceToken, { nodeId, nodeName: body.nodeName ?? nodeId });
      sendJson(res, 200, { nodeId, deviceToken });
      return;
    }

    // ---- 以下数据面端点全部 Bearer 鉴权（hub spec §3.1）----
    if (bearerNode(req) === null) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (url === '/resources/catalog' && method === 'GET') {
      sendJson(res, 200, buildCatalog());
      return;
    }

    if (url === '/resources/publish' && method === 'POST') {
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers['content-type'] ?? '');
      const manifestPart = parts.find((p) => p.name === 'manifest');
      const packagePart = parts.find((p) => p.name === 'package');
      if (!manifestPart || !packagePart) {
        sendJson(res, 400, { error: 'bad_multipart' });
        return;
      }
      const manifest = JSON.parse(manifestPart.data.toString('utf-8')) as {
        slug: string; type: string; name: string; version: string; author: string;
        description: string; readme: string; tags?: string[]; category?: string; iconEmoji?: string;
      };
      hubPublishVersion(
        {
          slug: manifest.slug, type: manifest.type, name: manifest.name, version: manifest.version,
          author: manifest.author, description: manifest.description, readme: manifest.readme,
          tags: Array.isArray(manifest.tags) ? manifest.tags : [],
          category: manifest.category ?? '', iconEmoji: manifest.iconEmoji ?? '📦',
          bytes: packagePart.data,
        },
        true,
      );
      hub.publishRequests.push({
        slug: manifest.slug, type: manifest.type, version: manifest.version, author: manifest.author,
      });
      const rec = hub.resources.get(manifest.slug)!.versions.get(manifest.version)!;
      sendJson(res, 201, {
        slug: manifest.slug, version: manifest.version, checksum: rec.checksum, sizeBytes: rec.sizeBytes,
      });
      return;
    }

    const downloadMatch = /^\/resources\/([^/]+)\/([^/]+)\/download$/.exec(url);
    if (downloadMatch && method === 'GET') {
      const slug = decodeURIComponent(downloadMatch[1]!);
      const version = decodeURIComponent(downloadMatch[2]!);
      const rec = hub.resources.get(slug)?.versions.get(version);
      if (!rec) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const key = `${slug}@${version}`;
      hub.downloads.set(key, (hub.downloads.get(key) ?? 0) + 1);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': rec.bytes.length });
      res.end(rec.bytes);
      return;
    }

    if (url === '/workspaces/snapshots' && method === 'POST') {
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers['content-type'] ?? '');
      const manifestPart = parts.find((p) => p.name === 'manifest');
      const payloadPart = parts.find((p) => p.name === 'payload');
      if (!manifestPart || !payloadPart) {
        sendJson(res, 400, { error: 'bad_multipart' });
        return;
      }
      const manifest = JSON.parse(manifestPart.data.toString('utf-8')) as {
        workspaceName: string; version: string; resources: unknown[];
      };
      const snapshotId = `snap-e2e-${hub.snapshots.size + 1}`;
      hub.snapshots.set(snapshotId, {
        bytes: payloadPart.data,
        checksum: crypto.createHash('sha256').update(payloadPart.data).digest('hex'),
        workspaceName: manifest.workspaceName,
      });
      hub.snapshotUploads.push({
        workspaceName: manifest.workspaceName, version: manifest.version, resources: manifest.resources.length,
      });
      sendJson(res, 201, { snapshotId, checksum: hub.snapshots.get(snapshotId)!.checksum });
      return;
    }

    const snapshotDownload = /^\/workspaces\/snapshots\/([^/]+)\/download$/.exec(url);
    if (snapshotDownload && method === 'GET') {
      const snap = hub.snapshots.get(decodeURIComponent(snapshotDownload[1]!));
      if (!snap) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': snap.bytes.length,
        'X-Checksum-Sha256': snap.checksum,
      });
      res.end(snap.bytes);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0]!;
    if (url !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (sock) => {
      const auth = req.headers.authorization;
      const nodeId = typeof auth === 'string' && auth.startsWith('Bearer ')
        ? (hub.nodes.get(auth.slice('Bearer '.length))?.nodeId ?? '')
        : '';
      if (nodeId !== '') hub.conns.set(nodeId, sock);
      hub.allSockets.add(sock);
      sock.on('message', (raw) => handleWsMessage(sock, raw, nodeId));
      sock.on('close', () => {
        hub.allSockets.delete(sock);
        for (const [id, s] of hub.conns) if (s === sock) hub.conns.delete(id);
      });
      sock.on('error', () => { /* 连接错误——close 兜底清理 */ });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      hub.baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
  hub.server = server;
}

// ──────────────────────────────────────────────────────────────────────────
// Electron 启动 / 通用 UI helper（沿 smoke/browser/composer spec 既有模式）
// ──────────────────────────────────────────────────────────────────────────

async function launchApp(userData: string): Promise<ElectronApplication> {
  const electronPath = electronRequire('electron') as string;
  const app = await electron.launch({
    // --user-data-dir 隔离 Chromium profile + AP_USER_DATA_DIR 隔离应用级路径
    // （state.db / skills / cache / workspaces）——theme/browser spec 同款先例
    args: [ELECTRON_APP_DIR, '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, AP_USER_DATA_DIR: userData },
    colorScheme: 'dark',
    timeout: 30000,
  });
  app.process().once('exit', (code) => {
    if (code !== 0) throw new Error(`Electron main process exited with code ${code}`);
  });
  return app;
}

/** 跳过首启引导 → 内嵌表单创建工作空间 → 主布局就绪 */
async function skipOnboardingAndCreateWorkspace(win: Page, name: string, dir: string): Promise<void> {
  await win.getByRole('button', { name: '跳过引导' }).click({ timeout: 15000 });
  await win.getByLabel('名称').fill(name);
  await win.getByPlaceholder('选择或输入目录路径').fill(dir);
  await win.getByRole('button', { name: '创建', exact: true }).click();
  await expect(win.getByLabel('智能体', { exact: true })).toBeVisible({ timeout: 20000 });
}

/** 设置 → 节点互联 → enroll 表单接入 → 等已连接（WS hello 成功） */
async function enrollViaSettings(win: Page, nodeName: string): Promise<void> {
  await win.getByRole('button', { name: '设置', exact: true }).click();
  await win.getByRole('button', { name: '节点互联' }).click();
  await win.getByLabel('hub 地址').fill(hub.baseUrl);
  await win.getByLabel('节点名').fill(nodeName);
  await win.getByLabel('加入凭证').fill(ENROLL_TOKEN);
  await win.getByRole('button', { name: '接入', exact: true }).click();
  await expect(win.getByText('已连接', { exact: true })).toBeVisible({ timeout: 20000 });
}

/** 等某节点的 ws 连接在场（定向下发前提——enroll 后 hello 握手完成） */
async function waitForNodeConn(nodeName: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    for (const [, node] of hub.nodes) {
      if (node.nodeName === nodeName && hub.conns.has(node.nodeId)) return node.nodeId;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`节点 ${nodeName} 的 hub 连接未就绪`);
}

// ──────────────────────────────────────────────────────────────────────────
// 六场景（serial：场景 1/2/4/5/6 共享实例 A；场景 3 用全新 profile 实例 B）
// ──────────────────────────────────────────────────────────────────────────

test.describe.serial('hub 分发链 / readonly 即时拒 / 版本链（M2.3 Task 7）', () => {
  let appA: ElectronApplication | null = null;
  let winA: Page | null = null;
  let appB: ElectronApplication | null = null;

  test.beforeAll(async () => {
    fs.mkdirSync(userA, { recursive: true });
    fs.mkdirSync(userB, { recursive: true });
    fs.mkdirSync(wsDirA, { recursive: true });
    await startMockHub();
    // 预种子版本链 skill v1.0.0（场景 5 安装起点——不广播事件，静默在目录）
    hubPublishVersion(
      {
        slug: CHAIN_SLUG, type: 'skill', name: CHAIN_SLUG, version: '1.0.0', author: 'e2e-seed',
        description: '版本链 e2e fixture', readme: `# ${CHAIN_SLUG} v1`, tags: [], category: '',
        iconEmoji: '📦', bytes: await buildSkillArchive(CHAIN_SLUG, '1.0.0'),
      },
      false,
    );
  });

  test.afterAll(async () => {
    await appA?.close().catch(() => undefined);
    await appB?.close().catch(() => undefined);
    for (const sock of hub.allSockets) {
      try { sock.terminate(); } catch { /* 已关 */ }
    }
    hub.server?.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(denyFile, { force: true });
  });

  test('场景1 发布→记账：custom skill 发布 → hub 收包 → hub:{slug} 记账 + 已装角标', async () => {
    test.setTimeout(240_000);
    appA = await launchApp(userA);
    winA = await appA.firstWindow();
    await winA.waitForLoadState('domcontentloaded');
    await skipOnboardingAndCreateWorkspace(winA, WS_NAME, wsDirA);

    // 种 custom skill（preload 通道——browser/composer spec 同款先例；发布面走 UI）
    await winA.evaluate(async (skillName) => {
      const w = window as unknown as {
        api: {
          resource: { createSkill(input: { name: string; description: string; body: string }): Promise<unknown> };
        };
      };
      await w.api.resource.createSkill({
        name: skillName,
        description: 'hub 分发链 e2e fixture',
        body: '# hub dist e2e\n用于发布→记账→补装链路回归。',
      });
    }, SKILL_SLUG);

    await enrollViaSettings(winA, 'e2e-node-a');

    // 资源库 → Skill 页（custom 卡「发布到 hub」入口）
    await winA.getByRole('button', { name: '资源库', exact: true }).click();
    await winA.getByRole('button', { name: 'Skill', exact: true }).click();
    const customCard = winA.getByTestId(`resource-card-custom-skill-${SKILL_SLUG}`);
    await expect(customCard).toBeVisible({ timeout: 20000 });
    await customCard.getByRole('button', { name: '发布到 hub' }).click();

    const dlg = winA.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('版本').fill(SKILL_PUBLISH_VERSION);
    await dlg.getByRole('button', { name: '发布', exact: true }).click();

    // 发布成功回执（发布对话框四态机——成功态）
    await expect(dlg.getByText(`已发布 v${SKILL_PUBLISH_VERSION}`)).toBeVisible({ timeout: 30000 });

    // mock hub 收包面：multipart manifest part 解析（slug/type/version/author）
    const pub = hub.publishRequests.find((p) => p.slug === SKILL_SLUG && p.version === SKILL_PUBLISH_VERSION);
    expect(pub, '/resources/publish 应收到 manifest part').toBeDefined();
    expect(pub!.type).toBe('skill');
    expect(pub!.author).toBe('e2e-node-a');

    // 记账面：hub 页签已装角标（installed_packages `hub:{slug}` 行 → v{version} · 已是最新）
    await winA.getByLabel('来源筛选').selectOption('hub');
    const hubCard = winA.getByTestId(`resource-card-hub-skill-${SKILL_SLUG}`);
    await expect(hubCard).toBeVisible({ timeout: 20000 });
    await expect(hubCard.getByText(`v${SKILL_PUBLISH_VERSION} · 已是最新`)).toBeVisible();

    // 结构化复核：resource:list hub 源映射记账行（installed + installedVersion）
    const row = await winA.evaluate(async ([slug, type]) => {
      const w = window as unknown as {
        api: {
          resource: {
            list(filter: { type: string; source: string }): Promise<
              Array<{ slug: string; installed: boolean; installedVersion?: string }>
            >;
          };
        };
      };
      const items = await w.api.resource.list({ type, source: 'hub' });
      return items.find((i) => i.slug === slug) ?? null;
    }, [SKILL_SLUG, 'skill'] as const);
    expect(row, 'hub 源列表应含已发布 skill（记账反查）').not.toBeNull();
    expect(row!.installed).toBe(true);
    expect(row!.installedVersion).toBe(SKILL_PUBLISH_VERSION);

    // 收摊：关闭发布对话框（成功态「关闭」钮——防遮罩拦截后续场景点击）
    await dlg.getByRole('button', { name: '关闭' }).click();
    await expect(dlg).toBeHidden();
  });

  test('场景2 manifest 携带：镜像向导 S2 构建上传 → Skill 补装计数 ≥1', async () => {
    test.setTimeout(180_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();

    // 工作组 → 侧栏创建组（无组空态：创建表单直接展开）
    await winA!.getByRole('button', { name: '工作组', exact: true }).click();
    await winA!.getByLabel('组名').fill('e2e 分发组');
    await winA!.getByRole('button', { name: '创建', exact: true }).click();

    // 监控台组头 + leader 镜像入口
    await expect(winA!.getByText('e2e 分发组').first()).toBeVisible({ timeout: 15000 });
    await winA!.getByRole('button', { name: '镜像工作空间…' }).click();

    const wizard = winA!.getByRole('dialog', { name: '镜像工作空间向导' });
    await expect(wizard).toBeVisible();
    // S1 选空间 → 下一步进 S2（入步自动构建）
    await wizard.getByLabel('工作空间').selectOption({ label: WS_NAME });
    await wizard.getByRole('button', { name: '下一步', exact: true }).click();

    // S2 完成：快照构建清单回填真实计数——已发布 skill 占 resources 补装位（1 补装 + 0 内嵌）
    await expect(wizard.getByText('1 补装 + 0 内嵌')).toBeVisible({ timeout: 45000 });
    await expect(wizard.getByText('已上传 hub 存档', { exact: true })).toBeVisible();

    // mock hub 收包面：POST /workspaces/snapshots manifest part 携带 skill 资源引用
    const upload = hub.snapshotUploads.find((u) => u.workspaceName === WS_NAME);
    expect(upload, '/workspaces/snapshots 应收到快照').toBeDefined();
    expect(upload!.resources, 'manifest.resources 应携带 skill 引用').toBeGreaterThanOrEqual(1);

    // 收摊（不进 S3——本场景只锁构建面）
    await wizard.getByRole('button', { name: '取消' }).click();
    await expect(wizard).toBeHidden();
  });

  test('场景4 readonly 即时拒：bash 越界写 → task.report kind=denied「只读档位」', async () => {
    test.setTimeout(300_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();

    // fixture：mock LLM provider + custom agent（bash 工具）+ ws 成员（建后停——委派回合自会拉起）
    await winA!.evaluate(async ([llmBase, wsName, agentSlug]) => {
      const w = window as unknown as {
        api: {
          workspace: { list(): Promise<Array<{ id: string; name: string }>> };
          provider: {
            create(input: {
              name: string; baseUrl: string; apiKey: string; defaultModel?: string; platform?: string;
            }): Promise<{ id: string }>;
          };
          agent: {
            createCustom(input: {
              name: string; slug: string; description: string; systemPrompt: string;
              scope: 'global'; modelProviderId: string; modelName: string;
              defaultTools?: Array<{ kind: string; ref: string }>;
            }): Promise<{ id: string }>;
            assign(workspaceId: string, defId: string, agentUserId: string): Promise<{ instanceId: string }>;
            stop(instanceId: string): Promise<{ ok: boolean }>;
          };
        };
      };
      const ws = (await w.api.workspace.list()).find((x) => x.name === wsName);
      if (!ws) throw new Error('workspace 不存在');
      const prov = await w.api.provider.create({
        name: 'E2E Mock LLM',
        baseUrl: llmBase,
        apiKey: 'e2e-mock-key',
        defaultModel: 'e2e-mock-model',
        platform: 'openai',
      });
      const def = await w.api.agent.createCustom({
        name: '只读执行员',
        slug: agentSlug,
        description: 'readonly deny e2e fixture',
        systemPrompt: '你是 e2e 只读执行员，按要求调用工具。',
        scope: 'global',
        modelProviderId: prov.id,
        modelName: 'e2e-mock-model',
        defaultTools: [{ kind: 'builtin', ref: 'bash' }],
      });
      // agentUserId 必须用生产格式 agent-<slug>-<后缀>：write-blocked 归属解析
      // （resolveStreamOwner 的 sender LIKE 'agent-%'）依赖此前缀，@ 前缀会解析
      // 出 sessionId=null → readonly 即时拒不触发（误弹授权卡）
      const member = await w.api.agent.assign(ws.id, def.id, `agent-${agentSlug}-e2e001`);
      await w.api.agent.stop(member.instanceId);
    }, [`${hub.baseUrl}/v1`, WS_NAME, 'e2e-readonly-worker'] as const);

    // mock LLM 剧本：① tool_call(bash 越界写) ② 终幕文本
    hub.llmScript = ['deny-write', 'final-text'];

    // mock hub 定向 task.assigned（permissionTier=readonly——协议 1.2.0 容错扩展字段）
    const nodeId = await waitForNodeConn('e2e-node-a');
    const sent = sendToNode(nodeId, {
      v: 1,
      kind: 'evt',
      method: 'task.assigned',
      payload: {
        taskId: TASK_ID,
        workspaceName: WS_NAME,
        task: {
          title: '只读越界写验证',
          prompt: '请用 bash 在用户主目录创建一个文件。',
          agentSlug: 'e2e-readonly-worker',
          permissionTier: 'readonly',
        },
        byNode: 'node-e2e-leader',
      },
    });
    expect(sent, 'task.assigned 应送达实例 A 的 hub 连接').toBe(true);

    // 断言面：task.report 进度拍 kind='denied' + excerpt 含「只读档位即时拒绝」
    await expect
      .poll(
        () => {
          const reports = hub.taskReports.get(TASK_ID) ?? [];
          return reports.some(
            (r) => r.status === 'running' && r.progress?.kind === 'denied' &&
              (r.progress.excerpt ?? '').includes('只读档位即时拒绝'),
          );
        },
        { timeout: 180_000, intervals: [1500], message: '应收到 kind=denied 的进度拍（excerpt 含「只读档位即时拒绝」）' },
      )
      .toBe(true);

    // 回合收敛：终态上报（denied 后 mock LLM 收尾 → done）
    await expect
      .poll(
        () => (hub.taskReports.get(TASK_ID) ?? []).some((r) => r.status === 'done' || r.status === 'failed'),
        { timeout: 60000, intervals: [1000] },
      )
      .toBe(true);
    // 越界写确实被拦：目标文件不应存在
    expect(fs.existsSync(denyFile), 'seatbelt 应拦截工作空间外写').toBe(false);
  });

  test('场景5 版本链 v1→v2：安装 v1 → 发布 v2 事件 → 「更新」前进到 v2', async () => {
    test.setTimeout(240_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();

    await winA!.getByRole('button', { name: '资源库', exact: true }).click();
    await winA!.getByRole('button', { name: 'Skill', exact: true }).click();
    await winA!.getByLabel('来源筛选').selectOption('hub');

    // 起点：目录预种子 v1.0.0 → 安装
    const chainCard = winA!.getByTestId(`resource-card-hub-skill-${CHAIN_SLUG}`);
    await expect(chainCard).toBeVisible({ timeout: 20000 });
    await chainCard.getByRole('button', { name: '安装', exact: true }).click();
    await expect(winA!.getByTestId('install-notice')).toContainText(`已从 momo-hub 安装「${CHAIN_SLUG}」`, { timeout: 30000 });
    await expect(chainCard.getByText('v1.0.0 · 已是最新')).toBeVisible({ timeout: 15000 });
    expect(downloadCount(CHAIN_SLUG, '1.0.0'), 'v1 归档应下载一次').toBe(1);

    // hub 升版 v2.0.0 + resource.published 广播（renderer hubUpdates 角标判定源）
    hubPublishVersion(
      {
        slug: CHAIN_SLUG, type: 'skill', name: CHAIN_SLUG, version: '2.0.0', author: 'e2e-seed',
        description: '版本链 e2e fixture', readme: `# ${CHAIN_SLUG} v2`, tags: [], category: '',
        iconEmoji: '📦', bytes: await buildSkillArchive(CHAIN_SLUG, '2.0.0'),
      },
      true,
    );

    // 事件驱动「可更新」角标（semver 前进才可更新——D3-4）
    await expect(chainCard.getByText('可更新')).toBeVisible({ timeout: 20000 });
    await expect(chainCard.getByText('v1.0.0 → v2.0.0')).toBeVisible();

    // 更新 → fresh 目录 latest(v2) > 已装(v1) → 前进安装（T2 语义）
    await chainCard.getByRole('button', { name: '更新', exact: true }).click();
    await expect(winA!.getByTestId('install-notice')).toContainText(`已从 momo-hub 更新「${CHAIN_SLUG}」`, { timeout: 45000 });
    await expect(chainCard.getByText('v2.0.0 · 已是最新')).toBeVisible({ timeout: 20000 });

    // 下载面：v2 一次；v1 不重复
    expect(downloadCount(CHAIN_SLUG, '2.0.0'), 'v2 归档应下载一次').toBe(1);
    expect(downloadCount(CHAIN_SLUG, '1.0.0'), 'v1 不应重复下载').toBe(1);
  });

  test('场景6 已是最新如实报：同版再装 → alreadyLatest 零动作不重装', async () => {
    test.setTimeout(120_000);
    expect(winA, '依赖场景5的 v2 已装态').not.toBeNull();

    const result = await winA!.evaluate(async (id) => {
      const w = window as unknown as {
        api: { resource: { install(id: string): Promise<Record<string, unknown>> } };
      };
      return w.api.resource.install(id);
    }, `hub-skill-${CHAIN_SLUG}`);

    // HubInstallResult 契约（M2.3 T2）：alreadyLatest:true + 已装版本如实回传
    expect((result as { alreadyLatest?: boolean }).alreadyLatest).toBe(true);
    expect((result as { version?: string }).version).toBe('2.0.0');

    // 零动作：无第二次下载（不重装——不谎报「已更新」）
    expect(downloadCount(CHAIN_SLUG, '2.0.0'), '同版再装不得重复下载').toBe(1);
  });

  test('场景3 全新 profile 零 unresolved：mirror.apply → 补装 skill → 回执无 skill:*', async () => {
    test.setTimeout(300_000);

    // 全新 profile 实例 B（隔离 userData——零工作空间零 skill 记账）
    appB = await launchApp(userB);
    const winB = await appB.firstWindow();
    await winB.waitForLoadState('domcontentloaded');
    await winB.getByRole('button', { name: '跳过引导' }).click({ timeout: 15000 });
    // 不建工作空间——镜像 apply 会创建（ensureWorkspace 落 <userData>/workspaces）
    await enrollViaSettings(winB, 'e2e-node-b');

    // 场景2 上传的快照 → 定向 mirror.apply 到 B（req id = mirrorId 对账键）
    const snapshot = hub.snapshotUploads.find((u) => u.workspaceName === WS_NAME);
    expect(snapshot, '依赖场景2的快照存档').toBeDefined();
    const snapshotId = [...hub.snapshots.entries()].find(([, s]) => s.workspaceName === WS_NAME)![0];
    const nodeB = await waitForNodeConn('e2e-node-b');
    hub.pendingMirrors.add(MIRROR_ID);
    const sent = sendToNode(nodeB, {
      v: 1,
      kind: 'req',
      id: MIRROR_ID,
      method: 'mirror.apply',
      payload: { mirrorId: MIRROR_ID, snapshotId, workspaceName: WS_NAME, strategy: 'replace' },
    });
    expect(sent, 'mirror.apply 应送达实例 B').toBe(true);

    // 回执：ok + appliedResources 含补装 skill + unresolvedRefs 无 skill:*
    await expect
      .poll(() => hub.mirrorReceipts.has(MIRROR_ID), { timeout: 180_000, intervals: [1500], message: '应收到 mirror.receipt' })
      .toBe(true);
    const receipt = hub.mirrorReceipts.get(MIRROR_ID)!;
    expect(receipt.ok, `镜像应成功应用（payload: ${JSON.stringify(receipt.payload)}）`).toBe(true);
    const applied = receipt.payload['appliedResources'] as string[];
    expect(applied, '补装清单应含 skill/e2e-hub-dist-skill').toContain(`skill/${SKILL_SLUG}`);
    const unresolved = (receipt.payload['unresolvedRefs'] as string[] | undefined) ?? [];
    expect(
      unresolved.filter((u) => u.startsWith('skill:')),
      '回执不得出现任何 skill:* unresolved（先装后落闭合）',
    ).toEqual([]);

    // 落库面：B 工作空间已建 + hub 记账已装（结构化复核）
    const check = await winB.evaluate(async ([wsName, slug]) => {
      const w = window as unknown as {
        api: {
          workspace: { list(): Promise<Array<{ id: string; name: string }>> };
          resource: {
            list(filter: { type: string; source: string }): Promise<
              Array<{ slug: string; installed: boolean; installedVersion?: string }>
            >;
          };
        };
      };
      const ws = (await w.api.workspace.list()).find((x) => x.name === wsName);
      const rows = await w.api.resource.list({ type: 'skill', source: 'hub' });
      const hit = rows.find((r) => r.slug === slug) ?? null;
      return { hasWs: ws !== undefined, installed: hit?.installed ?? false, version: hit?.installedVersion ?? null };
    }, [WS_NAME, SKILL_SLUG] as const);
    expect(check.hasWs, '镜像应创建同名工作空间').toBe(true);
    expect(check.installed, 'B 应经补装链安装该 skill 并落记账').toBe(true);
    expect(check.version).toBe(SKILL_PUBLISH_VERSION);
  });
});
