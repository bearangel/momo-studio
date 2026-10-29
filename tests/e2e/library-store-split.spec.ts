// tests/e2e/library-store-split.spec.ts
//
// library-store-split（spec 2026-10-29 §4 / §5）e2e 回归：
//   1. 库页纯本地断言：接入 mock hub（目录含未装 skill）→ 资源库 Skill 页——
//      未装 hub 目录条目不入网格（收窄语义）；来源下拉仅本地三档
//      （全部/系统预置/自定义）；外部市场弹层入口不渲染。
//   2. hub 弹窗安装链：「＋」菜单远端组（hub 置顶）→「从 momo-hub 获取…」弹窗
//      列目录条目（含脚注连接态）→ 行内「安装」→ 真实安装链（catalog → 下载
//      tar.gz → 落盘记账）→ 成功横幅 + 库页出现已装 hub 卡。
//
// mock hub 惯例沿 hub-distribution.spec.ts（单端口 node:http + ws；enroll 无鉴权、
// 数据面 Bearer；目录 latest=semver max、versions 降序；下载端点回归档字节），
// 仅保留本 spec 消费的最小端面（enroll / ws hello+ping / catalog / download）。
// 目录 revision 显式给值（脚注「修订 N」断言面——validateHubCatalog 1.5 语义）。
//
// 运行（同既有 e2e 惯例，需先 build + electron-rebuild ABI 149）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3 -w keytar
//   npx pnpm@9.0.0 e2e tests/e2e/library-store-split.spec.ts
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

/** hub 协议版本（与 momo-hub pin 对齐——protocol-pin.test.ts 同步纪律） */
const HUB_PROTO_VER = '1.5.0';
const ENROLL_TOKEN = 'join-e2e-token';
const NODE_NAME = 'e2e-lib-node';
const CUSTOM_SKILL = 'e2e-lib-custom-skill';
const HUB_SKILL_SLUG = 'e2e-lib-hub-skill';
const HUB_SKILL_VERSION = '1.0.2';
const CATALOG_REVISION = 7;

const runId = `${Date.now()}-${process.pid}`;
const tmpRoot = path.join(os.tmpdir(), `momo-lib-split-e2e-${runId}`);
const userProfile = path.join(tmpRoot, 'profile');
const wsDir = path.join(tmpRoot, 'ws');

interface WsLike {
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

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
  /** slug → { type, versions: Map<version, { manifest, bytes, checksum }> } */
  resources: new Map<string, { type: string; versions: Map<string, { manifest: Record<string, unknown>; bytes: Buffer; checksum: string }> }>(),
  /** deviceToken → nodeId */
  nodes: new Map<string, string>(),
  allSockets: new Set<WsLike>(),
};

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

function buildCatalog(): Record<string, unknown> {
  const items = [...hub.resources.entries()].map(([slug, entry]) => {
    const versions = [...entry.versions.values()].sort((a, b) =>
      semverCompare(String((b.manifest as { version: string }).version), String((a.manifest as { version: string }).version)),
    );
    const latest = versions[0]!;
    const m = latest.manifest as Record<string, string>;
    return {
      slug,
      type: entry.type,
      name: m.name,
      version: m.version,
      author: m.author,
      description: m.description,
      readme: m.readme,
      tags: latest.manifest.tags as string[],
      category: m.category,
      iconEmoji: m.iconEmoji,
      verificationStatus: 'unverified',
      downloadUrl: `/resources/${encodeURIComponent(slug)}/${encodeURIComponent(m.version)}/download`,
      checksum: latest.checksum,
      sizeBytes: latest.bytes.length,
      publishedAt: Date.now(),
      versions: versions.map((v) => (v.manifest as { version: string }).version),
    };
  });
  return { version: '1', revision: CATALOG_REVISION, updatedAt: new Date().toISOString(), items };
}

async function startMockHub(): Promise<void> {
  const { WebSocketServer } = electronRequire('ws') as {
    WebSocketServer: new (opts: { noServer: boolean }) => {
      on(event: 'connection', cb: (sock: WsLike, req: IncomingMessage) => void): void;
      handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer, cb: (sock: WsLike) => void): void;
    };
  };
  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0]!;
    const method = req.method ?? 'GET';

    if (url === '/enroll' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf-8')) as { nodeName?: string; enrollmentToken?: string };
      if (body.enrollmentToken !== ENROLL_TOKEN) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      const nodeId = `node-lib-${hub.nodes.size + 1}`;
      const deviceToken = `tok-lib-${hub.nodes.size + 1}`;
      hub.nodes.set(deviceToken, nodeId);
      sendJson(res, 200, { nodeId, deviceToken });
      return;
    }

    const auth = req.headers.authorization;
    const bearerOk = typeof auth === 'string' && auth.startsWith('Bearer ') && hub.nodes.has(auth.slice('Bearer '.length));
    if (!bearerOk) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (url === '/resources/catalog' && method === 'GET') {
      sendJson(res, 200, buildCatalog());
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
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': rec.bytes.length });
      res.end(rec.bytes);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (sock) => {
      hub.allSockets.add(sock);
      sock.on('message', (raw) => {
        let env: { kind?: string; id?: string; method?: string; payload?: unknown };
        try {
          env = JSON.parse(String(raw)) as typeof env;
        } catch {
          return;
        }
        if (env.kind !== 'req' || typeof env.id !== 'string' || typeof env.method !== 'string') return;
        const payload =
          env.method === 'hello'
            ? { hubId: 'e2e-lib-hub', protoVer: HUB_PROTO_VER, serverTime: Date.now(), onlineNodes: [] }
            : env.method === 'ping'
              ? { ts: Date.now(), serverTime: Date.now() }
              : { ok: true };
        sock.send(JSON.stringify({ v: 1, kind: 'res', id: env.id, method: env.method, ok: true, payload }));
      });
      sock.on('close', () => hub.allSockets.delete(sock));
      sock.on('error', () => { /* close 兜底清理 */ });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      hub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  hub.server = server;
}

/** skill 归档构造（tar.gz，SKILL.md 在根——installPackage 解压即注册面） */
async function buildSkillArchive(slug: string, version: string): Promise<Buffer> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `momo-lib-e2e-${slug}-`));
  try {
    fs.writeFileSync(
      path.join(stage, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: ${slug} lib-split fixture\nversion: ${version}\n---\n\n# ${slug} ${version}\n\nlibrary store split e2e fixture.\n`,
    );
    const archive = path.join(stage, 'pkg.tar.gz');
    await execFileAsync('tar', ['czf', archive, '-C', stage, 'SKILL.md']);
    return fs.readFileSync(archive);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function launchApp(userData: string): Promise<ElectronApplication> {
  const electronPath = electronRequire('electron') as string;
  const app = await electron.launch({
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

test.describe.serial('资源库「库/商店」分离（library-store-split）', () => {
  let app: ElectronApplication | null = null;
  let win: Page | null = null;

  test.beforeAll(async () => {
    fs.mkdirSync(userProfile, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });
    await startMockHub();
    // 预种子 hub 目录 skill（未安装——库页不可见、弹窗可装）
    const bytes = await buildSkillArchive(HUB_SKILL_SLUG, HUB_SKILL_VERSION);
    const entry = hub.resources.get(HUB_SKILL_SLUG) ?? { type: 'skill', versions: new Map() };
    entry.versions.set(HUB_SKILL_VERSION, {
      manifest: {
        slug: HUB_SKILL_SLUG, type: 'skill', name: '库商店分离技能', version: HUB_SKILL_VERSION,
        author: NODE_NAME, description: 'hub 目录中的未装 skill（只在获取弹窗可见）',
        readme: `# ${HUB_SKILL_SLUG}`, tags: [], category: 'dev', iconEmoji: '📦',
      },
      bytes,
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    hub.resources.set(HUB_SKILL_SLUG, entry);
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    for (const sock of hub.allSockets) {
      try { sock.terminate(); } catch { /* 已关 */ }
    }
    hub.server?.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('库页纯本地：未装 hub 目录条目不入网格；来源下拉三档；外部市场退场', async () => {
    test.setTimeout(240_000);
    app = await launchApp(userProfile);
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.getByRole('button', { name: '跳过引导' }).click({ timeout: 15000 });
    await win.getByLabel('名称').fill('e2e-lib-ws');
    await win.getByPlaceholder('选择或输入目录路径').fill(wsDir);
    await win.getByRole('button', { name: '创建', exact: true }).click();
    await expect(win.getByLabel('智能体', { exact: true })).toBeVisible({ timeout: 20000 });

    // 种 custom skill（库页本地实体锚点——custom 卡在场）
    await win.evaluate(async (skillName) => {
      const w = window as unknown as {
        api: { resource: { createSkill(input: { name: string; description: string; body: string }): Promise<unknown> } };
      };
      await w.api.resource.createSkill({
        name: skillName,
        description: '库页纯本地断言锚点',
        body: '# lib split e2e\n本地 custom 实体。',
      });
    }, CUSTOM_SKILL);

    await win.getByRole('button', { name: '设置', exact: true }).click();
    await win.getByRole('button', { name: '节点互联' }).click();
    await win.getByLabel('hub 地址').fill(hub.baseUrl);
    await win.getByLabel('节点名').fill(NODE_NAME);
    await win.getByLabel('加入凭证').fill(ENROLL_TOKEN);
    await win.getByRole('button', { name: '接入', exact: true }).click();
    await expect(win.getByText('已连接', { exact: true })).toBeVisible({ timeout: 20000 });

    // 资源库 → Skill 页
    await win.getByRole('button', { name: '资源库', exact: true }).click();
    await win.getByRole('button', { name: 'Skill', exact: true }).click();

    // custom 卡可见 = load 已完成（hub 目录面并行 settle 后才有此卡）
    await expect(win.getByTestId(`resource-card-custom-skill-${CUSTOM_SKILL}`)).toBeVisible({ timeout: 20000 });

    // 未装 hub 目录条目不入网格（收窄语义——同物两卡消解）
    await expect(win.getByTestId(`resource-card-hub-skill-${HUB_SKILL_SLUG}`)).toHaveCount(0);
    await expect(win.getByText('库商店分离技能')).toHaveCount(0);

    // 来源下拉仅本地三档（全部/系统预置/自定义——hub 档退场）
    const options = win.getByLabel('来源筛选').locator('option');
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText(/全部 \d+/);
    await expect(options.nth(1)).toHaveText(/系统预置 \d+/);
    await expect(options.nth(2)).toHaveText(/自定义 \d+/);

    // 外部市场弹层入口退场
    await expect(win.getByRole('button', { name: '外部市场' })).toHaveCount(0);
  });

  test('hub 弹窗安装链：AddMenu 远端组（hub 置顶）→ 弹窗目录 → 安装 → 落库页', async () => {
    test.setTimeout(240_000);
    expect(win, '场景1 已建实例复用').not.toBeNull();
    const page = win!;

    // 「＋」菜单远端组：hub 置顶 → 网络市场（Smithery 仅 MCP，skill 页不出现）
    await page.getByRole('button', { name: '添加技能' }).click();
    const menu = page.locator('[role="menu"]');
    await expect(menu.getByText('从 momo-hub 获取…')).toBeVisible();
    await expect(menu.getByText('从网络市场获取…')).toBeVisible();
    await expect(menu.getByText('从 Smithery 获取…')).toHaveCount(0);

    await menu.getByText('从 momo-hub 获取…').click();
    const dialog = page.getByRole('dialog', { name: '从 momo-hub 获取技能' });
    await expect(dialog).toBeVisible({ timeout: 20000 });

    // 弹窗目录行 + 脚注连接态（已连接 {节点名} · 目录 N 项 · 修订 R）
    const row = dialog.getByTestId(`fetch-row-hub-skill-${HUB_SKILL_SLUG}`);
    await expect(row).toBeVisible({ timeout: 20000 });
    await expect(row.getByText('库商店分离技能')).toBeVisible();
    await expect(row.getByRole('button', { name: '安装' })).toBeVisible();
    await expect(dialog.getByText(`已连接 ${NODE_NAME} · 目录 1 项 · 修订 ${CATALOG_REVISION}`)).toBeVisible();

    // 行内安装 → 真实安装链（catalog → 下载 → 落盘记账）
    await row.getByRole('button', { name: '安装' }).click();

    // 成功横幅（installNotice——装完落库页）+ 库页出现已装 hub 卡
    await expect(page.getByTestId('install-notice')).toContainText('已从 momo-hub 安装「库商店分离技能」', { timeout: 60000 });
    await expect(page.getByTestId(`resource-card-hub-skill-${HUB_SKILL_SLUG}`)).toBeVisible({ timeout: 20000 });

    // 弹窗行切换到「已装最新」灰显（安装后行刷新）
    await expect(row.getByText(`✓ 已装 v${HUB_SKILL_VERSION} · 最新`)).toBeVisible({ timeout: 20000 });

    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
  });
});
