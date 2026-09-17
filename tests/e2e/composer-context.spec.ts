// tests/e2e/composer-context.spec.ts
//
// v2.11 输入框上下文系统 e2e（Task 13）：真实构建应用全链路——
// 启动 → 建 workspace → 加 agent 成员 → ⚡ 快速会话（首次设默认 agent）
// → @ 统一菜单（agent+文件同浮层，v2.11.1）→ / 技能菜单 → 发送 → 消息气泡 context chip 渲染。
//
// 被测链路（Task 1-12 全链消费 + v2.11.1 交互精简）：
//   - @ 触发统一菜单（v2.11.1：移除 @/ 独立语法，agent + 文件同浮层双源过滤）
//     文件分支：ipc.file.searchNames（主进程 WorkspaceFS 实时递归扫描）→ 菜单选择
//     → 正文 @路径 标记 + pendingFiles chip
//   - / 触发（空 body 锚定）→ 命令组（session.listCommands，主进程 commands.ts
//     单一真相源）+ 技能组（ipc.resource.list 过滤 installed，builtin 三技能）
//     → 技能选择 → pendingSkills chip（正文不插入）
//   - 发送（session.send 第 4 参 context）→ 主进程落 messages.context_json →
//     session:message 推送 → MessageBubble 渲染 data-testid=message-context-chips
//
// 会话建立说明（brief 骨架的「会话建立 helper」实际不存在——旧 e2e-full 走 v1.x
// 已 skip，本 spec 自建 v2.x 链路）：输入框需 activeSessionId 才启用，快速会话
// 需 workspace 默认 agent。fixture（agent 定义 + 成员 + 默认 agent）经 preload
// API 种子（不走 UI 的根因见步骤 2 注释），会话本身走真实 UI ⚡ 快速会话建立。
// 发送后 agent 侧因无 API key 可能拉起失败——不影响断言：sendUserMessage 先
// 落库推送后路由，路由失败不向 IPC 抛错（session-service 语义，气泡渲染不依赖
// sendMessage resolve）。
//
// 运行（同 smoke/theme/browser spec，需先 build 双 workspace；容器内 xvfb + electron-rebuild ABI）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3
//   xvfb-run -a npx pnpm@9.0.0 e2e tests/e2e/composer-context.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

const tmpUserData = path.join(os.tmpdir(), `momo-composer-e2e-${Date.now()}-${process.pid}`);
const tmpWsDir = path.join(os.tmpdir(), `momo-composer-e2e-ws-${Date.now()}-${process.pid}`);

test.beforeAll(() => {
  fs.mkdirSync(tmpUserData, { recursive: true });
  fs.mkdirSync(tmpWsDir, { recursive: true });
  // @ 统一菜单文件分支数据源是 searchNames 实时扫描 workspace 目录——
  // 预写 package.json 保证 '@package' 查询有稳定命中（v2.11.1 移除 @/ 独立语法）
  fs.writeFileSync(
    path.join(tmpWsDir, 'package.json'),
    JSON.stringify({ name: 'momo-composer-e2e', version: '1.0.0' }, null, 2),
  );
});

test.afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
  fs.rmSync(tmpWsDir, { recursive: true, force: true });
});

test('输入框支持文件引用与技能 chip：@ 文件 → / 技能 → 发送 → 气泡 chip', async () => {
  test.setTimeout(180000);

  const app = await electron.launch({
    // --user-data-dir 隔离 Chromium profile（对齐 browser/theme 先例——
    // AP_USER_DATA_DIR 只路由应用级路径 state.db / logs / skills）
    args: [ELECTRON_APP_DIR, '--no-sandbox', `--user-data-dir=${tmpUserData}`],
    env: { ...process.env, AP_USER_DATA_DIR: tmpUserData },
    colorScheme: 'dark',
    timeout: 30000,
  });

  app.process().once('exit', (code) => {
    if (code !== 0) {
      throw new Error(`Electron main process exited with code ${code}`);
    }
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // ---- 1. 首启空态 → 创建 workspace（内嵌表单，同 browser.spec 先例） ----
    await win.getByLabel('名称').fill('E2E 上下文');
    await win.getByPlaceholder('点击右侧按钮选择目录').fill(tmpWsDir);
    await win.getByRole('button', { name: '创建', exact: true }).click();

    // 主布局就绪标志：活动栏 Agent 入口可见
    await expect(win.getByLabel('Agent', { exact: true })).toBeVisible({ timeout: 20000 });

    // ---- 2. fixture 种子：agent 定义 + ws 成员 + 默认 agent ----
    // 经 preload API（与 UI 同一 IPC 通道，browser.spec 先例 win.evaluate + w.api.*）。
    // 不走 UI 建档的根因：v1.1 起 builtin agent 不再启动注册，资源库 catalog 的
    // agent 条目 downloadUrl 全空（builtin 直显已安装、不可装）→ AddAgentDialog
    // 定义表空而空态；「+ 创建 Agent」必填供应商+模型，而 agent:addMember 链上
    // resolveApiKey 必经 keytar（headless 容器无 DBus Secret Service 直接抛错）且
    // 强制 provider 行存在。改走同在 preload 面暴露的裸 CRUD 通道 agent.assign
    // （纯 DB 插成员，无 keytar / 无 spawn；createCustomDef 对显式传入的
    // modelProviderId 不做存在性校验，占位 provider 即可建档）。成员建好后显式
    // agent.stop 置离线——建表 last_running DEFAULT 1（存量兼容语义），不 stop 则
    // setDefaultAgent 的 restart 链又会踩 keytar。本 spec 被测面是 composer 上下文
    // 链，agent 无真实 LLM 凭据不影响断言（见文件头说明）。
    await win.evaluate(async () => {
      const w = window as unknown as {
        api: {
          workspace: {
            list(): Promise<Array<{ id: string }>>;
            setDefaultAgent(workspaceId: string, instanceId: string | null): Promise<void>;
          };
          agent: {
            createCustom(input: {
              name: string;
              slug: string;
              description: string;
              systemPrompt: string;
              scope: 'global';
              modelProviderId: string;
              modelName: string;
            }): Promise<{ id: string }>;
            assign(
              workspaceId: string,
              defId: string,
              agentUserId: string,
            ): Promise<{ instanceId: string }>;
            stop(instanceId: string): Promise<{ ok: boolean }>;
          };
        };
      };
      const list = await w.api.workspace.list();
      const ws = list[0];
      if (!ws) throw new Error('workspace 列表为空');
      const def = await w.api.agent.createCustom({
        name: 'E2E 助手',
        slug: 'e2e-helper',
        description: 'composer-context e2e fixture',
        systemPrompt: '你是 e2e 测试助手',
        scope: 'global',
        modelProviderId: 'e2e-fixture-provider',
        modelName: 'e2e-fixture-model',
      });
      const member = await w.api.agent.assign(ws.id, def.id, '@e2e-helper');
      await w.api.agent.stop(member.instanceId);
    });

    // ---- 3. IM 视图 → ⚡ 快速会话（renderer workspace store 未感知 fixture 写库，
    // 仍弹 DefaultAgentPickerDialog → 选成员设默认并继续，真实 UI 路径） ----
    await win.getByLabel('会话', { exact: true }).click();
    await win.getByLabel('快速会话').click();

    const picker = win.getByRole('dialog');
    const radio = picker.getByRole('radio');
    await expect(radio).toHaveCount(1, { timeout: 10000 });
    await radio.first().click();
    await picker.getByRole('button', { name: '设为默认并继续' }).click();

    // 快速会话建立 → 输入框启用（placeholder 从「请先选择房间」切到发送提示）
    const input = win.getByPlaceholder(/Enter 发送.*输入 @ 提到 agent/);
    await expect(input).toBeEnabled({ timeout: 15000 });

    // ---- 5. @ 文件引用：@ 前缀（v2.11.1 统一菜单）→ 选 package.json ----
    // 文件搜索 debounce 200ms + IPC，断言自带 15s 超时窗足够
    await input.fill('@package');
    await expect(win.getByText('引用文件')).toBeVisible();
    await win.getByRole('button', { name: 'package.json', exact: true }).click();
    await expect(input).toHaveValue(/@package\.json/);
    // pendingFiles chip：aria-label「移除文件 <path>」，展示文本为 basename
    await expect(win.getByLabel('移除文件 package.json')).toBeVisible();

    // ---- 6. / 技能：空 body 以 / 开头 → 命令+技能两组 → 选择技能出 chip ----
    // 技能组数据源 = 已安装技能：全新 userData 仅 catalog 的 builtin skill
    // 「代码审查工作流」（Task 12 预置三技能包装机后才进列表）。命令按钮可访问名
    // 含描述文本，用前缀匹配锚定
    await input.fill('/');
    await expect(win.getByRole('button', { name: /^\/compact/ })).toBeVisible();
    await expect(win.getByText('技能', { exact: true })).toBeVisible();
    await win.getByRole('button', { name: '代码审查工作流', exact: true }).click();
    // 技能选择不插正文：/ 局部输入被剥掉，body 归空
    await expect(input).toHaveValue('');
    await expect(win.getByLabel('移除技能 代码审查工作流')).toBeVisible();

    // ---- 7. 输入正文发送 → 气泡 context chip 渲染（context_json 落库回读全链） ----
    await input.fill('检查一下');
    await input.press('Enter');

    const chips = win.getByTestId('message-context-chips');
    await expect(chips).toBeVisible();
    await expect(chips.getByText('代码审查工作流')).toBeVisible();
    // 文件 chip 是可点按钮（点击打开编辑器），aria-label 即完整相对路径
    await expect(chips.getByRole('button', { name: 'package.json' })).toBeVisible();
  } finally {
    await app.close();
  }
});
