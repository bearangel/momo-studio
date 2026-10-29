// tests/e2e/task-dependencies.spec.ts
//
// M4.0 T2（spec 2026-10-29 §2.1）——M3.3 任务依赖链 e2e 沉淀（单实例，纯本地零 hub）。
//
// 被测链路（五场景，M3.3 真机验收 UC-1/2/4/5 的 e2e 化）：
//   1. 批量 `::` 建链：CreateTaskDialog 批量模式三行（A 无依赖 / B :: T-A / C :: T-B，
//      T-id 顺序生成——建链前按当前库 max seq 预测，批内先行项落库后行校验即通过）
//      → B/C 卡 blocked「阻塞」角标 + 悬停 title「等待依赖完成：<T-id>」；A 无角标
//   2. blocked 双闸拒绝（四闸中的入队闸 + 启动闸）：
//      B 详情抽屉「启动」→ 面板错误条「任务存在未完成依赖（T-001），依赖完成前不可入队」；
//      evaluate task:start → 拒绝「依赖完成前不可启动」（同含 T-id 人话）
//   3. DAG 视图：依赖图入口可切 + 分层渲染（A 第 1 层 / B 第 2 层 / C 第 3 层）
//      + 只读（dag 画板零 sortable 注册——aria-roledescription 计数锁）+ 可切回
//   4. A 完成（evaluate IPC：scheduledAt 未来防 executor 抢跑 + 状态机链
//      assigned → in_progress → completed）→ B 角标消失（C 仍在——正负双控）
//   5. 批量 5 行含 1 行坏依赖（引用不存在 T-999）→ 4 成 1 败 per-line 错误
//      （toast 摘要含坏行原文 + 「依赖任务 T-999 不存在」）+ 4 张新卡落板
//   6. M4.3 外派派发闸全链（mock hub 最小面——hello/ping/group.*/task.*，结构沿
//      hub-distribution.spec mock hub 裁剪）：外派批量两行（受阻行 :: T-B 未完成 /
//      解锁行 :: T-A 已完成）→ 受阻行建链落板 blocked + 提交 toast 人话拒绝
//      「任务存在未完成依赖（T-002），依赖完成前不可派发」+ 解锁行即刻委派
//      （mock hub 捕获 task.dependsOn 透传）→ B 完成（evaluate 状态机链）→
//      受阻行卡右键「重试派发」→ toast「已派发给」（retryDispatch 闸放行）
//
// 触达深度标注（如实记录）：
//   - 建链 / 角标 / DAG / 批量部分成功：全真实 UI 面（CreateTaskDialog 批量语法 →
//     task:createBatch 单 IPC → 依赖边落库 → blocked 派生 → BoardCard/BoardCanvas 渲染）。
//   - 四闸文案断言面：入队闸走真实 UI（详情抽屉「启动」按钮 → task.move → 面板
//     错误条）；启动闸走 evaluate 直调 task:start IPC（renderer 无非拖拽的启动 UI 入口，
//     拖拽面被本票「无拖拽零几何」约束排除——useBoardDrop 对同一 IPC 错误是
//     showToast 直出，消息源同点 move.ts/lifecycle.ts，语义不改）。
//     move→active 列的依赖闸（move.ts「不可启动」分支）要求任务先入 assigned 态，
//     对「建链即 blocked」的 draft 任务不可达（状态机预检先行拒绝）——与启动闸
//     同模板同源（lifecycle.ts 单点），此处不重复构造。
//   - A 完成：evaluate IPC（状态机合法链），卡片操作路径（拖拽入已完成列）因
//     零几何约束不采用——两侧同走 transitionTaskStatus 单点。
//   - 场景 6：外派提交链全真实 UI（CreateTaskDialog 外派 `::` 解析 →
//     hub:submitRoutedTask → 建链 → 闸拒绝 per-line toast）；hub 侧为 mock
//     （真实 hub 链背书 = tests/hub 单测 + hub-distribution e2e——本场景锁闸语义，
//     不重复锁 hub 行为）；重试派发走真实卡菜单 → hub:retryDispatch。
//
// 运行（同既有 e2e 惯例，需先 build 双 workspace）：
//   npx pnpm@9.0.0 build && npx pnpm@9.0.0 e2e tests/e2e/task-dependencies.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo, IncomingMessage } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const electronRequire = createRequire(path.join(__dirname, '..', '..', 'electron', 'package.json'));
const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

const WS_NAME = 'e2e-deps-ws';
const TITLE_A = '链头任务A';
const TITLE_B = '链中任务B';
const TITLE_C = '链尾任务C';
const BAD_DEP_ID = 'T-999';

const tmpUserData = path.join(os.tmpdir(), `momo-task-deps-${Date.now()}-${process.pid}`);

/** 任务 id 预测：`T-<seq>`（seq = 库内 max + 1，零填充 ≥3 位——repo.nextTaskId 同式） */
function formatTaskId(seq: number): string {
  return `T-${String(seq).padStart(3, '0')}`;
}

/** evaluate 专用：renderer window.api 的任务/工作空间/hub 最小面（preload 同形状） */
type WinApi = {
  api: {
    workspace: { list(): Promise<Array<{ id: string; name: string }>> };
    task: {
      list(input: { workspaceId: string }): Promise<Array<{ id: string }>>;
      update(id: string, patch: Record<string, unknown>): Promise<void>;
      transition(id: string, to: string): Promise<unknown>;
      start(id: string, opts?: Record<string, unknown>): Promise<unknown>;
    };
    hub: {
      getStatus(): Promise<{ state: string }>;
      enroll(input: { hubUrl: string; enrollmentToken: string; nodeName: string }): Promise<unknown>;
      groupCreate(input: { groupName: string }): Promise<{ groupId: string }>;
    };
  };
};

async function launchApp(): Promise<ElectronApplication> {
  const electronPath = electronRequire('electron') as string;
  const app = await electron.launch({
    args: [ELECTRON_APP_DIR, '--no-sandbox', `--user-data-dir=${tmpUserData}`],
    env: { ...process.env, AP_USER_DATA_DIR: tmpUserData },
    colorScheme: 'dark',
    timeout: 30000,
  });
  app.process().once('exit', (code) => {
    if (code !== 0) throw new Error(`Electron main process exited with code ${code}`);
  });
  return app;
}

/** 跳过首启引导 → 内嵌表单创建工作空间 → 主布局就绪（smoke/kanban-drag 同款） */
async function skipOnboardingAndCreateWorkspace(win: Page): Promise<void> {
  await win.getByRole('button', { name: '跳过引导' }).click({ timeout: 15000 });
  await win.getByLabel('名称').fill(WS_NAME);
  await win.getByPlaceholder('选择或输入目录路径').fill(path.join(tmpUserData, 'ws'));
  await win.getByRole('button', { name: '创建', exact: true }).click();
  await expect(win.getByRole('heading', { name: '新建工作空间' })).toBeHidden({ timeout: 15000 });
}

/** 预测接下来 n 个任务 id（建链行内 `::` 后缀需要先行项的真实 T-id） */
async function predictNextTaskIds(win: Page, count: number): Promise<string[]> {
  const maxSeq = await win.evaluate((wsName) => {
    const w = window as unknown as WinApi;
    return w.api.workspace
      .list()
      .then((list) => {
        const ws = list.find((x) => x.name === wsName);
        if (!ws) throw new Error('workspace 不存在');
        return w.api.task.list({ workspaceId: ws.id });
      })
      .then((rows) =>
        rows.reduce((acc, r) => {
          const m = /^T-(\d+)$/.exec(r.id);
          return m ? Math.max(acc, Number(m[1])) : acc;
        }, 0),
      );
  }, WS_NAME);
  return Array.from({ length: count }, (_, i) => formatTaskId(maxSeq + 1 + i));
}

/** 批量建任务：看板 → 新建任务 → 批量模式 → 逐行填充 → 提交 → Esc 关自动弹出的详情抽屉 */
async function createBatchTasks(win: Page, lines: string[]): Promise<void> {
  await win.getByRole('button', { name: '新建任务' }).first().click();
  // 用「创建模式」radiogroup 圈定创建弹窗：标题随模式切换（新建任务 ↔ 批量新建）
  // 不宜按名定位；提交后自动弹出的任务详情抽屉同是 role=dialog，泛化定位会误命中
  const dlg = win.getByRole('dialog').filter({
    has: win.getByRole('radiogroup', { name: '创建模式' }),
  });
  await expect(dlg).toBeVisible();
  // Segmented 选项渲染为 radio（radiogroup「创建模式」）
  await dlg.getByRole('radio', { name: '批量' }).click();
  await dlg.locator('#create-task-batch').fill(lines.join('\n'));
  await dlg.getByRole('button', { name: `创建 ${lines.length} 个任务`, exact: true }).click();
  await expect(dlg).toBeHidden({ timeout: 15000 });
  // 批量只回调末次成功任务 → onCreated 自动选中开详情抽屉（全屏遮罩截指针）——Esc 收摊
  await win.keyboard.press('Escape');
  await expect(win.getByRole('dialog', { name: '任务详情' })).toBeHidden({ timeout: 10000 });
}

/** 看板卡片定位（BoardCard 根是 button，卡面文本 `#T-xxx · 标题`） */
function boardCard(win: Page, title: string) {
  return win.locator('button').filter({ hasText: title }).first();
}

// ── 场景 6 mock hub（最小面——结构沿 hub-distribution.spec 裁剪）─────────────

/**
 * mock hub 协议版本——必须与 momo-hub pin 对齐（pin v0.3.0 → 协议 1.7.0）。
 * ⚠️ 协议升级（pin bump）时必须与 electron/tests/hub/protocol-pin.test.ts
 * 同步更新本常量，否则 hello 协商失败（major 不匹配即拒连）。
 */
const HUB_PROTO_VER = '1.7.0';
/** mock 组内虚构在线成员（未真实 enroll——pickWorker 候选造数；委派下发 mock 吞掉） */
const WORKER_NODE_ID = 'node-e2e-w';
const WORKER_NODE_NAME = 'e2e-node-w';

interface WsLike {
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

const mockHub = {
  server: null as http.Server | null,
  baseUrl: '',
  /** deviceToken → 节点名（/enroll 登记） */
  nodes: new Map<string, { nodeId: string; nodeName: string }>(),
  /** nodeId → 活跃 ws 连接 */
  conns: new Map<string, WsLike>(),
  allSockets: new Set<WsLike>(),
  /** 工作组账本（group.create 登记：self + 虚构 worker 成员） */
  groups: [] as Array<{
    groupId: string; groupName: string;
    members: Array<{ nodeId: string; name: string; online: boolean }>;
  }>,
  /** task.delegate 收包捕获（brief 透传断言面：title → task.dependsOn 在场性） */
  delegateRequests: [] as Array<{ title: string; dependsOn?: string[] }>,
};

function mockReplyReq(sock: WsLike, req: { id: string; method: string }, ok: boolean, payload: unknown): void {
  sock.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, method: req.method, ok, payload }));
}

function mockBroadcastEvt(method: string, payload: unknown): void {
  const env = JSON.stringify({ v: 1, kind: 'evt', method, payload });
  for (const sock of mockHub.allSockets) {
    try { sock.send(env); } catch { /* 连接半关——忽略 */ }
  }
}

/** WS 控制面消息处理（hello/ping/group 族与 task 族——其余方法 ok 容忍） */
function handleMockWsMessage(sock: WsLike, raw: unknown, selfNodeId: string): void {
  let env: { kind?: string; id?: string; method?: string; payload?: unknown };
  try {
    env = JSON.parse(String(raw)) as { kind?: string; id?: string; method?: string; payload?: unknown };
  } catch {
    return;
  }
  if (env.kind !== 'req' || typeof env.method !== 'string') return;
  const req = { id: env.id ?? '', method: env.method };
  const payload = (env.payload ?? {}) as Record<string, unknown>;
  switch (env.method) {
    case 'hello':
      mockReplyReq(sock, req, true, {
        hubId: 'e2e-deps-hub-mock',
        protoVer: HUB_PROTO_VER,
        serverTime: Date.now(),
        onlineNodes: [],
      });
      return;
    case 'ping':
      mockReplyReq(sock, req, true, { ts: (payload as { ts?: number }).ts ?? Date.now(), serverTime: Date.now() });
      return;
    case 'group.create': {
      const groupId = `g-e2e-deps-${mockHub.groups.length + 1}`;
      const self = [...mockHub.nodes.values()].find((n) => n.nodeId === selfNodeId);
      mockHub.groups.push({
        groupId,
        groupName: String(payload.groupName ?? 'e2e 依赖组'),
        members: [
          { nodeId: selfNodeId, name: self?.nodeName ?? selfNodeId, online: true },
          // 虚构 worker：在线未镜像登记前的占位候选（mirroredBy 只造 worker 侧）
          { nodeId: WORKER_NODE_ID, name: WORKER_NODE_NAME, online: true },
        ],
      });
      mockReplyReq(sock, req, true, { groupId, nodeId: selfNodeId });
      return;
    }
    case 'group.list':
      mockReplyReq(sock, req, true, {
        groups: mockHub.groups.filter((g) => g.members.some((m) => m.nodeId === selfNodeId)),
      });
      return;
    case 'task.list':
      mockReplyReq(sock, req, true, { tasks: [] });
      return;
    case 'task.delegate': {
      // 记账 + 应答（不下发 task.assigned——本场景无真实 worker，只锁 leader 侧链）
      const task = (payload.task ?? {}) as { title?: unknown; dependsOn?: unknown };
      mockHub.delegateRequests.push({
        title: typeof task.title === 'string' ? task.title : '',
        dependsOn: Array.isArray(task.dependsOn) ? (task.dependsOn as string[]) : undefined,
      });
      mockReplyReq(sock, req, true, { taskId: `task-hub-${mockHub.delegateRequests.length}` });
      return;
    }
    default:
      mockReplyReq(sock, req, true, { ok: true });
      return;
  }
}

/** 起 mock hub（HTTP /enroll + /ws 控制面） */
async function startMockHub(): Promise<void> {
  const { WebSocketServer } = electronRequire('ws') as {
    WebSocketServer: new (opts: { noServer: boolean }) => {
      on(event: 'connection', cb: (sock: WsLike, req: IncomingMessage) => void): void;
      handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer, cb: (sock: WsLike) => void): void;
    };
  };
  const wss = new WebSocketServer({ noServer: true });
  let nodeSeq = 0;

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]!;
    if (url === '/enroll' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      req.on('end', () => {
        nodeSeq += 1;
        const nodeId = `node-e2e-leader-${nodeSeq}`;
        const deviceToken = `tok-e2e-${nodeSeq}`;
        const nodeName = (JSON.parse(body) as { nodeName?: string }).nodeName ?? nodeId;
        mockHub.nodes.set(deviceToken, { nodeId, nodeName });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ nodeId, deviceToken }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (sock) => {
      const auth = req.headers.authorization;
      const nodeId = typeof auth === 'string' && auth.startsWith('Bearer ')
        ? (mockHub.nodes.get(auth.slice('Bearer '.length))?.nodeId ?? '')
        : '';
      if (nodeId !== '') mockHub.conns.set(nodeId, sock);
      mockHub.allSockets.add(sock);
      sock.on('message', (raw) => handleMockWsMessage(sock, raw, nodeId));
      sock.on('close', () => {
        mockHub.allSockets.delete(sock);
        for (const [id, s] of mockHub.conns) if (s === sock) mockHub.conns.delete(id);
      });
      sock.on('error', () => { /* close 兜底清理 */ });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      mockHub.baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
  mockHub.server = server;
}

/** evaluate 直调 hub.enroll + 轮询等已连接（WS hello 成功） */
async function enrollViaEvaluate(win: Page, nodeName: string): Promise<void> {
  await win.evaluate(async ([hubUrl, name]) => {
    const w = window as unknown as WinApi;
    await w.api.hub.enroll({ hubUrl, enrollmentToken: 'e2e-deps-token', nodeName: name });
  }, [mockHub.baseUrl, nodeName] as const);
  await expect
    .poll(async () => (await win.evaluate(() => (window as unknown as WinApi).api.hub.getStatus())).state, { timeout: 20000 })
    .toBe('online');
}

test.describe.serial('任务依赖链（M3.3 沉淀：批量建链 / blocked 角标 / 双闸拒绝 / DAG / 解锁）', () => {
  let app: ElectronApplication | null = null;
  let win: Page | null = null;
  let idA = '';
  let idB = '';

  test.beforeAll(() => {
    fs.mkdirSync(tmpUserData, { recursive: true });
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    for (const sock of mockHub.allSockets) {
      try { sock.terminate(); } catch { /* 已关 */ }
    }
    mockHub.server?.close();
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  test('场景1 批量 `::` 建链 A→B→C：B/C blocked 角标 + 悬停 title，A 无角标', async () => {
    test.setTimeout(180_000);
    app = await launchApp();
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await skipOnboardingAndCreateWorkspace(win);

    await win.getByRole('button', { name: '看板', exact: true }).click({ timeout: 15000 });

    // 预测三个顺序 T-id：A=T-a（无依赖行），B :: T-a，C :: T-b（批内先行落库后行校验即通过）
    const [tidA, tidB] = await predictNextTaskIds(win, 2);
    idA = tidA;
    idB = tidB;
    await createBatchTasks(win, [TITLE_A, `${TITLE_B} :: ${tidA}`, `${TITLE_C} :: ${tidB}`]);

    // B/C 卡 blocked「阻塞」角标在场 + 悬停 title 含依赖 T-id；A 无角标
    const badgeB = boardCard(win, TITLE_B).locator('span[title^="等待依赖完成"]');
    await expect(badgeB).toBeVisible({ timeout: 15000 });
    await expect(badgeB).toHaveAttribute('title', `等待依赖完成：${tidA}`);
    await expect(badgeB).toHaveText('阻塞');
    const badgeC = boardCard(win, TITLE_C).locator('span[title^="等待依赖完成"]');
    await expect(badgeC).toBeVisible();
    await expect(badgeC).toHaveAttribute('title', `等待依赖完成：${tidB}`);
    await expect(boardCard(win, TITLE_A).locator('span[title^="等待依赖完成"]')).toHaveCount(0);
  });

  test('场景2 blocked 双闸拒绝：抽屉启动→入队闸 / task:start→启动闸（人话含 T-id）', async () => {
    test.setTimeout(120_000);
    expect(win, '依赖场景1的实例').not.toBeNull();

    // 前置：B 指派 agent 成员（抽屉「启动」按钮资格 = draft ∧ 有委派目标——
    // 无目标时按钮不渲染）。provider 仅落一行配置（baseUrl 指向不可达本地端口），
    // 本场景到不了 kickoff——blocked 闸在 move/start 的最前置，零 LLM 依赖。
    await win!.evaluate(async ([wsName, taskId]) => {
      const w = window as unknown as WinApi & {
        api: {
          provider: { create(input: Record<string, unknown>): Promise<{ id: string }> };
          agent: {
            createCustom(input: Record<string, unknown>): Promise<{ id: string }>;
            assign(workspaceId: string, defId: string, agentUserId: string): Promise<{ instanceId: string }>;
          };
        };
      };
      const ws = (await w.api.workspace.list()).find((x) => x.name === wsName);
      if (!ws) throw new Error('workspace 不存在');
      const prov = await w.api.provider.create({
        name: 'E2E 静默 provider',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'e2e-unused',
        defaultModel: 'e2e-unused-model',
        platform: 'openai',
      });
      const def = await w.api.agent.createCustom({
        name: '依赖链占位执行员',
        slug: 'e2e-deps-worker',
        description: 'blocked 闸 e2e fixture',
        systemPrompt: '占位',
        scope: 'global',
        modelProviderId: prov.id,
        modelName: 'e2e-unused-model',
      });
      // agentUserId 用生产格式 agent-<slug>-<后缀>（write-blocked 归属解析契约）
      const member = await w.api.agent.assign(ws.id, def.id, 'agent-e2e-deps-worker-001');
      await w.api.task.update(taskId, { assigneeAgentId: member.instanceId });
    }, [WS_NAME, idB] as const);

    // 闸①（入队，真实 UI 面）：B 详情抽屉「启动」= move→assigned → move.ts 依赖闸
    await boardCard(win!, TITLE_B).click();
    const drawer = win!.getByRole('dialog', { name: '任务详情' });
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await drawer.getByRole('button', { name: '启动', exact: true }).click();
    // 面板错误条（runAction → actionError——抽屉内的真实拒绝展示面）
    await expect(drawer.getByText('操作失败：').first()).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByText(`任务存在未完成依赖（${idA}），依赖完成前不可入队`)).toBeVisible();
    await win!.keyboard.press('Escape');
    await expect(drawer).toBeHidden({ timeout: 10000 });

    // 闸②（启动，IPC 直调面）：task:start → lifecycle.ts 依赖闸（renderer 无非拖拽
    // 启动入口，evaluate 直调同一生产 IPC；拒绝零副作用——blocked 先于任何写动作）
    const startErr = await win!.evaluate(async (id) => {
      const w = window as unknown as WinApi;
      try {
        await w.api.task.start(id, {});
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }, idB);
    // Electron IPC rejection 外层包「Error invoking remote method …」前缀（自定义
    // 属性不跨进程）——人话断言用包含式（原始消息逐字在内）
    expect(startErr, 'blocked 任务 task:start 应被拒（人话含依赖 T-id）').toContain(
      `任务存在未完成依赖（${idA}），依赖完成前不可启动`,
    );
  });

  test('场景3 DAG 视图：入口可切 + 分层渲染（A 1 层/B 2 层/C 3 层）+ 只读零 sortable', async () => {
    test.setTimeout(120_000);
    expect(win, '依赖场景1的实例').not.toBeNull();

    // 入口：BoardToolbar「依赖图」toggle（aria-pressed 亮起）
    const dagToggle = win!.getByRole('button', { name: '依赖图', exact: true });
    await dagToggle.click();
    await expect(dagToggle).toHaveAttribute('aria-pressed', 'true');
    const dagBoard = win!.getByTestId('dag-board');
    await expect(dagBoard).toBeVisible({ timeout: 10000 });
    // 无环：A→B→C 链分层（layerTasks 拓扑深度）
    await expect(dagBoard).toHaveAttribute('data-has-cycle', 'false');

    // 分层渲染：层列 aria-label=依赖层 N；A 无未完成依赖落第 1 层，B/C 依深度 2/3
    const layer1 = dagBoard.locator('section[aria-label="依赖层 1"]');
    const layer2 = dagBoard.locator('section[aria-label="依赖层 2"]');
    const layer3 = dagBoard.locator('section[aria-label="依赖层 3"]');
    await expect(layer1.getByText(TITLE_A)).toBeVisible();
    await expect(layer2.getByText(TITLE_B)).toBeVisible();
    await expect(layer3.getByText(TITLE_C)).toBeVisible();
    await expect(layer1.getByText('无未完成依赖')).toBeVisible();

    // 只读（无拖拽）：dag 分支渲染静态 BoardCard（不接 useSortable——外层
    // attributes 不落 DOM）；sortable 包装在画板模式才有 aria-roledescription
    await expect(dagBoard.locator('[aria-roledescription="sortable"]')).toHaveCount(0);

    // 可切回：再点「依赖图」→ 回平铺，dag 画板卸载
    await dagToggle.click();
    await expect(dagToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(dagBoard).toHaveCount(0);
    await expect(boardCard(win!, TITLE_A)).toBeVisible({ timeout: 10000 });
  });

  test('场景4 A 完成 → B 阻塞角标消失（C 仍阻塞——正负双控）', async () => {
    test.setTimeout(120_000);
    expect(win, '依赖场景1的实例').not.toBeNull();

    // A 完成（evaluate IPC）：scheduledAt 置未来防 executor 抢跑（peek 闸
    // scheduled_at <= now），再走状态机合法链 assigned → in_progress → completed
    await win!.evaluate(async (id) => {
      const w = window as unknown as WinApi;
      await w.api.task.update(id, { scheduledAt: Date.now() + 3600_000 });
      await w.api.task.transition(id, 'assigned');
      await w.api.task.transition(id, 'in_progress');
      await w.api.task.transition(id, 'completed');
    }, idA);

    // B 解锁：blocked 派生 = 依赖全部 completed（看板 5s 轮询刷新，留足窗口）
    await expect(
      boardCard(win!, TITLE_B).locator('span[title^="等待依赖完成"]'),
      'A 完成后 B 的依赖全部 completed → 角标应消失',
    ).toHaveCount(0, { timeout: 20000 });
    // C 仍阻塞（依赖 B 未完成）——防「角标全消」假阳
    await expect(boardCard(win!, TITLE_C).locator('span[title^="等待依赖完成"]')).toBeVisible();
  });

  test('场景5 批量 5 行 1 坏依赖：4 成 1 败 per-line 错误 + 4 张新卡落板', async () => {
    test.setTimeout(120_000);
    expect(win, '依赖场景1的实例').not.toBeNull();

    const goodTitles = ['批量行一', '批量行二', '批量行三', '批量行四'];
    const badLine = `坏依赖行 :: ${BAD_DEP_ID}`;
    // 坏行放中间：per-line 错误展示与行序解耦（union 部分成功——坏行前后行照建）
    const lines = [goodTitles[0]!, goodTitles[1]!, badLine, goodTitles[2]!, goodTitles[3]!];
    await createBatchTasks(win!, lines);

    // 4 成：四张无依赖新卡落板（批量只回调末次成功——本组末行是 goodTitles[3]）
    for (const t of goodTitles) {
      await expect(boardCard(win!, t)).toBeVisible({ timeout: 15000 });
    }
    // 坏行不落卡（创建失败——库内无此标题行）
    await expect(boardCard(win!, '坏依赖行')).toHaveCount(0);

    // 1 败 per-line 错误：部分成功走 toast 摘要（行原文 + 主进程逐行错误人话）
    const toast = win!.getByTestId('ui-toast');
    await expect(toast).toContainText('1 个任务创建失败', { timeout: 10000 });
    await expect(toast).toContainText(`「${badLine}」依赖任务 ${BAD_DEP_ID} 不存在`);
  });

  test('场景6 M4.3 外派派发闸：blocked 提交被拒 toast 人话 → 依赖完成 → 重试派发成功', async () => {
    test.setTimeout(240_000);
    expect(win, '依赖场景1的实例').not.toBeNull();

    await startMockHub();
    await enrollViaEvaluate(win!, 'e2e-node-leader');
    const { groupId } = await win!.evaluate(() =>
      (window as unknown as WinApi).api.hub.groupCreate({ groupName: 'e2e 依赖外派组' }));
    // 镜像登记造数（pickWorker 候选 = online ∧ mirroredBy——只造虚构 worker）：
    // 组内广播 workspace.mirrored → 主进程累积登记表 → 弹窗预检 mirrored=true
    mockBroadcastEvt('workspace.mirrored', {
      groupId,
      targetNodeId: WORKER_NODE_ID,
      workspaceName: WS_NAME,
      snapshotId: 'snap-e2e-deps-1',
      appliedResources: [],
    });

    // 外派批量两行：受阻行依赖 T-B（未完成）→ 建链落板 blocked + 派发被拒人话；
    // 解锁行依赖 T-A（场景4 已完成）→ 闸放行即刻委派（brief 透传 dependsOn）
    const blockedLine = `外派受阻行 :: ${idB}`;
    const unlockedLine = `外派解锁行 :: ${idA}`;
    await win!.getByRole('button', { name: '新建任务' }).first().click();
    const dlg = win!.getByRole('dialog').filter({
      has: win!.getByRole('radiogroup', { name: '创建模式' }),
    });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('radio', { name: '批量' }).click();
    await dlg.getByRole('radio', { name: '组内调度' }).click();
    await dlg.locator('#create-task-batch').fill(`${blockedLine}\n${unlockedLine}`);
    await dlg.getByRole('button', { name: '创建 2 个任务', exact: true }).click();
    await expect(dlg).toBeHidden({ timeout: 15000 });
    await win!.keyboard.press('Escape');
    await expect(win!.getByRole('dialog', { name: '任务详情' })).toBeHidden({ timeout: 10000 });

    // 闸拒绝 toast（per-line 摘要——文案单源与 retryDispatch 闸逐字一致）
    const toast = win!.getByTestId('ui-toast');
    await expect(toast).toContainText('1 个任务创建失败', { timeout: 10000 });
    await expect(toast).toContainText(
      `「${blockedLine}」任务存在未完成依赖（${idB}），依赖完成前不可派发`,
    );

    // 受阻行建链落板（行保留——M4.3 闸语义：建链账不回滚）+ blocked 角标
    const blockedCard = boardCard(win!, '外派受阻行');
    await expect(blockedCard).toBeVisible({ timeout: 15000 });
    await expect(blockedCard.locator('span[title^="等待依赖完成"]')).toHaveAttribute(
      'title',
      `等待依赖完成：${idB}`,
    );

    // 解锁行即刻委派：mock hub 捕获 task.delegate 载荷 dependsOn 透传（协议 1.7.0）
    await expect
      .poll(() => mockHub.delegateRequests.filter((r) => r.title === '外派解锁行').length, { timeout: 10000 })
      .toBe(1);
    expect(mockHub.delegateRequests.find((r) => r.title === '外派解锁行')?.dependsOn).toEqual([idA]);
    // 受阻行零委派（闸在 delegate 之前）
    expect(mockHub.delegateRequests.find((r) => r.title === '外派受阻行')).toBeUndefined();

    // B 完成（场景4 同款状态机合法链）→ 受阻行解锁
    await win!.evaluate(async (id) => {
      const w = window as unknown as WinApi;
      await w.api.task.update(id, { scheduledAt: Date.now() + 3600_000 });
      await w.api.task.transition(id, 'assigned');
      await w.api.task.transition(id, 'in_progress');
      await w.api.task.transition(id, 'completed');
    }, idB);

    // 重试派发（真实卡菜单 → hub:retryDispatch）：闸放行 → 已派发 toast
    await blockedCard.click({ button: 'right' });
    const menu = win!.getByRole('list', { name: '任务菜单 外派受阻行' });
    await menu.getByRole('button', { name: '重试派发' }).click();
    await expect(toast).toContainText('已派发给', { timeout: 15000 });
    await expect
      .poll(() => mockHub.delegateRequests.filter((r) => r.title === '外派受阻行').length, { timeout: 10000 })
      .toBe(1);
  });
});
