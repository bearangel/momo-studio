// .opencode/skills/momo-acceptance/references/qa-driver.mjs
//
// momo-acceptance canonical CDP driver（评审 P1-6 提交：散文规范 → 固化实现）
//
// 用法（复制到 RUN_DIR 后原样启动，勿改代码——通过环境变量参数化）：
//   cp .opencode/skills/momo-acceptance/references/qa-driver.mjs "$RUN_DIR/qa-driver.mjs"
//   QA_CDP_PORT=<port> QA_RUN_DIR=<RUN_DIR 绝对路径> node "$RUN_DIR/qa-driver.mjs"
//
// 职责：
//   1. playwright connectOverCDP 接管隔离实例（启动前须先 /json/close 掉 devtools:// target）
//   2. 持续监听 console error/warning、pageerror、requestfailed → 追加写 evidence/console.log
//      （真实（已授权）运行注意：requestfailed 只落 method+URL——URL 含敏感 query 时由驱动侧
//       统一剥离 query string 再落盘，配合技能「真实 profile 附加纪律」的脱敏要求）
//   3. 轮询 cmd/ 目录执行命令（*.cmd.json → *.result.json），实现逐步交互与证据采集
//
// 不变量（重写即丢，评审与狗粮双事故印证——改动须经评审）：
//   - 重启防重放：启动时从既有 *.result.json 播种已处理集合，绝不重复执行旧命令
//     （否则覆写既有证据——狗粮实测事故）
//   - 事件持续落盘：console/pageerror/requestfailed 监听器在连接建立后立即挂载，全程不拆
//
// 命令集（cmd/*.cmd.json 的 action 字段）：
//   url / title / snapshot（a11y 文本）/ screenshot / click / fill / press / type /
//   eval / waitFor / wait / quit
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const RUN = path.resolve(process.env.QA_RUN_DIR ?? path.dirname(new URL(import.meta.url).pathname));
const PORT = process.env.QA_CDP_PORT ?? '9222';
const CMD_DIR = path.join(RUN, 'cmd');
const EVID = path.join(RUN, 'evidence');
fs.mkdirSync(CMD_DIR, { recursive: true });
fs.mkdirSync(EVID, { recursive: true });
const log = (...a) => console.log(`[driver ${new Date().toISOString().slice(11, 19)}]`, ...a);

const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 15_000 });
const ctx = browser.contexts()[0];
// 目标页：vite dev server 加载的主窗口（缺省回落第一个页面）
const page =
  ctx.pages().find((p) => p.url().startsWith('http://localhost:5')) ??
  ctx.pages()[0];
log(`connected (port ${PORT}), page =`, page.url());

// —— 证据连续收集：console / pageerror / 网络失败（URL 剥离 query 落盘）——
const conlog = fs.createWriteStream(path.join(EVID, 'console.log'), { flags: 'a' });
const stamp = () => new Date().toISOString().slice(11, 23);
const stripQuery = (u) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}?…`;
  } catch {
    return u;
  }
};
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    conlog.write(`[${stamp()}][console:${m.type()}] ${m.text()}\n`);
});
page.on('pageerror', (e) => conlog.write(`[${stamp()}][pageerror] ${e.message}\n`));
page.on('requestfailed', (r) =>
  conlog.write(`[${stamp()}][requestfailed] ${r.method()} ${stripQuery(r.url())} → ${r.failure()?.errorText}\n`),
);

/** 定位器解析：优先 role+name，其次 placeholder，其次 text，最后 css（name 为子串匹配——歧义名用 css 作用域限定） */
function loc(spec) {
  if (spec.role) return page.getByRole(spec.role, { name: spec.name }).first();
  if (spec.placeholder) return page.getByPlaceholder(spec.placeholder).first();
  if (spec.text) return page.getByText(spec.text, { exact: !!spec.exact }).first();
  if (spec.css) return page.locator(spec.css).first();
  throw new Error('locator spec 需含 role/placeholder/text/css 之一');
}

async function exec(cmd) {
  const r = { id: cmd.id, action: cmd.action, ok: true };
  try {
    switch (cmd.action) {
      case 'url':
        r.url = page.url(); break;
      case 'title':
        r.title = await page.title(); break;
      case 'snapshot':
        r.snapshot = await page.locator('body').ariaSnapshot(); break;
      case 'screenshot':
        r.file = `evidence/${cmd.name}.png`;
        await page.screenshot({ path: path.join(EVID, `${cmd.name}.png`), fullPage: !!cmd.fullPage });
        break;
      case 'click': {
        const l = loc(cmd.target);
        await l.click({ timeout: cmd.timeout ?? 10_000 });
        r.clicked = JSON.stringify(cmd.target); break;
      }
      case 'fill': {
        const l = loc(cmd.target);
        await l.fill(cmd.value ?? '', { timeout: cmd.timeout ?? 10_000 });
        r.filled = (cmd.value ?? '').slice(0, 80); break;
      }
      case 'press':
        await page.keyboard.press(cmd.key); r.pressed = cmd.key; break;
      case 'type':
        await page.keyboard.type(cmd.text ?? '', { delay: 20 }); r.typed = (cmd.text ?? '').slice(0, 80); break;
      case 'eval':
        r.result = await page.evaluate(cmd.expr); break;
      case 'waitFor':
        await loc({ text: cmd.text }).waitFor({ state: 'visible', timeout: cmd.timeout ?? 10_000 });
        r.waited = cmd.text; break;
      case 'wait':
        await page.waitForTimeout(cmd.ms ?? 1000); r.ms = cmd.ms ?? 1000; break;
      default:
        throw new Error(`未知 action: ${cmd.action}`);
    }
  } catch (e) {
    r.ok = false; r.error = String(e.message ?? e).slice(0, 500);
  }
  return r;
}

// 不变量①：已有 result 的命令视为已处理——防重启重放覆写既有证据
const processed = new Set(
  fs.readdirSync(CMD_DIR).filter((f) => f.endsWith('.result.json')).map((f) => f.replace('.result.json', '.cmd.json')),
);

log('driver ready，开始轮询 cmd/ …');
for (;;) {
  const files = fs.readdirSync(CMD_DIR).filter((f) => f.endsWith('.cmd.json')).sort();
  for (const f of files) {
    if (processed.has(f)) continue;
    processed.add(f);
    const cmd = JSON.parse(fs.readFileSync(path.join(CMD_DIR, f), 'utf8'));
    const t0 = Date.now();
    const r = await exec(cmd);
    r.ms = Date.now() - t0;
    fs.writeFileSync(path.join(CMD_DIR, f.replace('.cmd.json', '.result.json')), JSON.stringify(r, null, 2));
    log(`${cmd.action} ${r.ok ? 'OK' : 'FAIL'} ${r.ms}ms${r.error ? ' :: ' + r.error : ''}`);
    if (cmd.action === 'quit') {
      await browser.close(); // 仅断开 CDP 连接，不杀 Electron
      process.exit(0);
    }
  }
  await new Promise((res) => setTimeout(res, 300));
}
