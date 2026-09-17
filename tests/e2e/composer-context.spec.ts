// tests/e2e/composer-context.spec.ts
//
// v3 输入框内联 pill 富输入块 e2e（Task 4 收尾）：真实构建应用全链路——
// 启动 → 建 workspace → 加 agent 成员 → ⚡ 快速会话（首次设默认 agent）
// → @ 统一菜单（v2.11.1）→ 文件 pill 内联 → / 技能菜单 → 技能 pill 内联
// → 输入正文发送 → 消息气泡 context chip 渲染。
//
// 被测链路（Task 1-3 全链消费 + v3 RichComposer 内联 pill 模型）：
//   - 编辑器是 contentEditable div（role=textbox 仍命中）；Playwright fill() 原生
//     支持 contentEditable（输入事件触发菜单）
//   - @ 触发统一菜单（v2.11.1：移除 @/ 独立语法，agent + 文件同浮层双源过滤）
//     文件分支：ipc.file.searchNames（主进程 WorkspaceFS 实时递归扫描）→ 菜单选择
//     → RichComposer.insertPill 插入文件 pill（contenteditable=false span，
//     data-kind="file"，文字流中原子块，取代 v2.11 的 pendingFiles chip）
//   - / 触发（空 body 锚定）→ 命令组（session.listCommands，主进程 commands.ts
//     单一真相源）+ 技能组（ipc.resource.list 过滤 installed，builtin 三技能）
//     → 技能选择 → 技能 pill（不进正文、随 context 第 3 参发送，
//     取代 v2.11 的 pendingSkills chip）
//   - 发送：serializeSegments(getSegments()) → sendMessage(body, mentions, context)
//     三参；IPC 形状与 v2.11 完全一致（主进程零感知）；消息气泡渲染
//     data-testid=message-context-chips（文件 chip 可点 + 技能 chip）
//
// contentEditable 适配要点（v3 编辑器）：
//   - 值断言：编辑器无 value 属性，toHaveValue 失效；改用 toHaveText /
//     toContainText（Playwright 读 textContent，pill 文字 + ZWSP 都在内）
//   - pill 文本形态——file pill 显示 label（路径，无 @ 前缀；@ 前缀仅
//     serializeSegments 阶段添加进 body），skill pill 显示 label（技能名）
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
  // v3 RichComposer 仍消费同一菜单（file pill 替换旧 pendingFiles chip）
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

    // 快速会话建立 → 输入框启用（v3：placeholder 是 data-placeholder 属性在
// contentEditable div 上，aria-label='消息输入框'；不能用 getByPlaceholder 匹配）
// 同时存在「搜索会话」input（aria-label 同类），用 role+name 精确锁定
    const input = win.getByRole('textbox', { name: '消息输入框' });
    await expect(input).toBeEnabled({ timeout: 15000 });

    // ---- 5. / 技能：编辑器为空 → / 触发命令+技能菜单 → 选技能 → 技能 pill 内联 ----
    // v3 编辑器是 contentEditable div；fill 触发 input 事件 → detectTrigger 拉起菜单
    // 关键：/ 菜单正则 /^\/([^\s/]*)$/ 要求 body 为空（pill 折叠为单空格，非空）。
    // 因此顺序必须是「/ 技能 → @ 文件 → 正文」——技能 pill 必须在文件 pill 之前
    // （MentionInput.tsx 注释「命令/技能 pill 只能是编辑器第一个节点，整串语义保持」）。
    // 后续步骤不能用 fill（会 select-all 替换、清掉已插 pill）——改 type 保留 pill。
    await input.fill('/');
    await expect(win.getByRole('button', { name: /^\/compact/ })).toBeVisible();
    await expect(win.getByText('技能', { exact: true })).toBeVisible();
    await win.getByRole('button', { name: '代码审查工作流', exact: true }).click();
    // 技能选择不插正文：/ 触发字符被剥掉、skill pill 替代——编辑器现在
    // 含技能 pill（label = 技能名；spec §3：技能不进 body），编辑器
    // textContent 应包含技能名；空字符串断言（toHaveValue('')）已不适用
    await expect(input).toContainText('代码审查工作流');
    await expect(input.locator('span[data-kind="skill"]')).toHaveCount(1);

    // ---- 6. @ 文件引用：@ 前缀（v2.11.1 统一菜单）→ 选 package.json → 文件 pill 内联 ----
    // 文件搜索 debounce 200ms + IPC，断言自带 15s 超时窗足够
    // 文件菜单可在 pill 之后触发：@ 触发正则 (?:^|\s)@([^\s#]*)$ 允许非空 body
    // （pill 折叠单空格作为前导空白边界）。先 click 重聚焦编辑器（菜单按钮偷焦点）
    // 再 type ——contentEditable 上 fill 会 select-all 抹掉已有 skill pill
    await input.click();
    await input.type('@package');
    await expect(win.getByText('引用文件')).toBeVisible();
    await win.getByRole('button', { name: 'package.json', exact: true }).click();
    // 文件 pill 文本形态：pillDisplayText(file) = label（路径，无 @ 前缀；
    // @ 前缀仅 serializeSegments 阶段加进 body）。编辑器无 value 属性，改用
    // toHaveText / toContainText 读 textContent（含 pill 文字 + 末尾 ZWSP）
    await expect(input).toContainText('package.json');
    // 直接断言内联 pill 元素存在（data-kind=file）：与 v2.11 的「移除文件」
    // aria-label chip 等价但语义不同——v3 没有独立 pendingFiles chip，
    // pill 本身就是引用；删除通过 Backspace 两段式（点选 + 整删）
    await expect(input.locator('span[data-kind="file"][data-id="package.json"]')).toHaveCount(1);

    // ---- 7. 输入正文发送 → 气泡 context chip 渲染（context_json 落库回读全链） ----
    // 关键：不能用 fill('检查一下')——fill 会 select-all 抹掉两个 pill；
    // type() 在光标处追加，pill 保留 → serializeSegments 时 files+skills 都进 context
    await input.click();
    await input.type('检查一下');
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
