// tests/e2e/kanban-drag.spec.ts
//
// 看板拖拽冒烟（看板重构 Task 14）：启动真实 Electron（构建产物）→
//   首启空态建工作空间 → 切看板视图 → 新建任务（draft → 待办列）→
//   Esc 关创建后自动弹出的详情抽屉 → 鼠标事件序列（dnd-kit PointerSensor
//   需分步 move 过激活阈值）拖到已关闭列 → 断言卡片移动到位
//   （draft → cancelled 语义动作，无确认框）。
//
// 运行（需先 build 双 workspace + electron-rebuild better-sqlite3；容器内 xvfb）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3
//   npx pnpm@9.0.0 e2e tests/e2e/kanban-drag.spec.ts
//
// 定位模式照搬 smoke.spec.ts：electron.launch(AP_USER_DATA_DIR 隔离) +
// getByLabel/getByRole 语义选择器（ActivityBar「看板」/ BoardColumn 列
// section[aria-label=列名]）。
import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const electronRequire = createRequire(
  path.join(__dirname, '..', '..', 'electron', 'package.json'),
);
const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

const tmpUserData = path.join(os.tmpdir(), `momo-kanban-drag-${Date.now()}-${process.pid}`);

test.beforeAll(() => {
  fs.mkdirSync(tmpUserData, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

test('看板拖拽冒烟：新建任务落待办列 → 拖到已关闭列 → 卡片移动到位', async () => {
  const electronPath = electronRequire('electron') as string;

  const app = await electron.launch({
    args: [ELECTRON_APP_DIR, '--no-sandbox'],
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

    // 1. 首启空态：内嵌创建工作空间表单（smoke.spec 同款定位）
    await win.getByLabel('名称').fill('拖拽冒烟', { timeout: 15000 });
    await win.getByPlaceholder('点击右侧按钮选择目录').fill(path.join(tmpUserData, 'ws'));
    await win.getByRole('button', { name: '创建', exact: true }).click();

    // 2. 切看板视图（ActivityBar「看板」项）
    await win.getByRole('button', { name: '看板', exact: true }).click({ timeout: 15000 });

    // 3. 新建任务（侧边栏与工具栏同名入口，任一可用）
    await win.getByRole('button', { name: '新建任务' }).first().click();
    await win.getByLabel('标题*').fill('拖拽冒烟任务');
    await win.getByRole('button', { name: '创建', exact: true }).click();

    // 4. 断言卡片在待办列（BoardColumn section aria-label=列名）
    const backlog = win.locator('section[aria-label="待办"]');
    await expect(backlog.getByText('拖拽冒烟任务')).toBeVisible({ timeout: 15000 });

    // 创建后 onCreated 自动选中 → 任务详情抽屉叠加在画板上（全屏遮罩截走指针事件），
    // 先 Esc 关抽屉再拖（TaskDetailDrawer Esc 语义）
    await win.keyboard.press('Escape');
    await expect(win.getByRole('dialog', { name: '任务详情' })).toBeHidden({ timeout: 10000 });

    // 5. 拖拽：待办列卡片 → 已关闭列（分步 move 过 PointerSensor 5px 激活阈值）。
    //    目标选已关闭而非已分配：assigned 列语义要求任务先有委派目标（move.ts
    //    「任务未设置委派目标」拒绝），首启工作空间无 agent 无法满足；closed 列
    //    （cancel 语义）与 assigned 同为跨列拖拽链路（激活/碰撞/落点/move IPC/
    //    状态迁移渲染），且 draft→closed 无确认框直落
    const cardBox = await backlog.getByText('拖拽冒烟任务').boundingBox();
    const targetBox = await win.locator('section[aria-label="已关闭"]').boundingBox();
    if (!cardBox || !targetBox) throw new Error('卡片或目标列不可见，无法拖拽');

    await win.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 10);
    await win.mouse.down();
    await win.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 20,
    });
    await win.mouse.up();

    // 6. 断言卡片移动到位（draft → cancelled 语义动作，无确认框直落）
    await expect(
      win.locator('section[aria-label="已关闭"]').getByText('拖拽冒烟任务'),
    ).toBeVisible({ timeout: 15000 });
  } finally {
    await app.close();
  }
});
