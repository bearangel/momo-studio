// run_js：office 文档生成代码工坊（spec 2026-11-03 §5.2）。
// CJS 插件工具模块：纯 node 可达，不得 require electron / app 内部模块——
// 沙箱执行（execSandboxed）与变更记账（recordFileChange）均经 ToolContext 注入。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const BOOTSTRAP = path.resolve(__dirname, '../bootstrap/run.js');
const VENDOR_ROOT = path.resolve(__dirname, '../vendor');
const SCRIPT_MAX_BYTES = 64 * 1024;
const OUTPUT_CAP_BYTES = 24 * 1024;

const DEF = {
  name: 'run_js',
  description:
    '在离线沙箱中执行 JavaScript 生成/改造 office 文档（pptx/xlsx/docx/pdf）。' +
    '预置库：pptxgenjs / exceljs / docx / pdfkit / adm-zip / momo-chart（xlsx 原生图表注入）/' +
    'momo-pptx-zip（pptx 模板手术）/ momo-validate（产物结构校验）。' +
    '环境现实：无网络；仅 workspace 与系统 tmp 可写（越界写抛错）；超时默认 120s。' +
    '产物文件必须列入 outputs（记账与撤销的唯一依据，未声明写入不可撤销）。' +
    '收工前必须 require("momo-validate").validateOfficeFile 校验每个产物。',
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'JS 源码（CommonJS，顶层 await 可用）。文件写 workspace 相对路径（cwd=workspace），上限 64KB' },
      outputs: { type: 'array', items: { type: 'string' }, description: '产物 workspace 相对路径列表（覆盖已存在文件需先 office_read 读过）' },
      timeout_ms: { type: 'number', description: '执行超时毫秒（默认 120000，钳制 [1000, 300000]）' },
    },
    required: ['script'],
  },
};

function parseOutputs(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('参数 outputs 必须是字符串数组');
  return raw.map((p, i) => {
    if (typeof p !== 'string' || p.length === 0) throw new Error(`outputs[${i}] 必须是非空字符串`);
    return p;
  });
}

module.exports.createTools = function createTools() {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() {
      return [{
        name: 'run_js',
        displayName: 'run_js 代码工坊',
        description: DEF.description,
        category: '办公',
        categoryEmoji: '',
        defaultOn: false,
      }];
    },
    handles(name) { return name === 'run_js'; },
    async execute(name, args, ctx) {
      if (name !== 'run_js') throw new Error(`未知工具: ${name}`);
      // 宿主设施门禁：不降级裸跑（Review Focus #5）
      if (typeof ctx.execSandboxed !== 'function') {
        throw new Error('run_js 需要宿主注入 execSandboxed（App 版本过旧或运行时未装配）——请升级 Momo Studio');
      }
      const script = typeof args.script === 'string' ? args.script : '';
      if (script.length === 0) throw new Error('参数 script 缺失');
      if (Buffer.byteLength(script, 'utf-8') > SCRIPT_MAX_BYTES) {
        throw new Error('参数 script 超过 64KB 上限——拆分为多次小脚本执行');
      }
      const outputs = parseOutputs(args.outputs);
      const timeoutMs = typeof args.timeout_ms === 'number'
        ? Math.min(Math.max(Math.round(args.timeout_ms), 1000), 300000)
        : 120000;

      // outputs 预检：越界拒绝 + 已存在文件 Read-before-Edit 门禁 + before 字节
      const tracked = outputs.map((rel) => {
        const abs = ctx.wsFs.assertInWorkspace(rel);
        const existed = fs.existsSync(abs);
        if (existed && ctx.readTracker && typeof ctx.readTracker.assertRead === 'function') {
          try {
            // 三参真实签名（read-tracker.ts）：未读/读后漂移抛错；包装语义对齐
            // office-tools 的 assertReadForOffice——补充 office_read 指引
            ctx.readTracker.assertRead(ctx.roomId, ctx.parentStreamSessionId, abs);
          } catch (err) {
            throw new Error(`${err && err.message ? err.message : String(err)}（office 文档可用 office_read 读取）`);
          }
        }
        return { rel, abs, existed, before: existed ? fs.readFileSync(abs) : null };
      });

      if (!fs.existsSync(BOOTSTRAP) || !fs.existsSync(VENDOR_ROOT)) {
        throw new Error('插件安装不完整（bootstrap/vendor 缺失）——请重装 office-pro 插件');
      }

      // exec 前置中止检查：已中止的回合不再拉起子进程（Task 2 审查增强）
      if (ctx.abortSignal && ctx.abortSignal.aborted) return '已中断';

      const scriptPath = path.join(os.tmpdir(), `office-pro-${crypto.randomUUID()}.js`);
      fs.writeFileSync(scriptPath, script, 'utf-8');
      try {
        const res = await ctx.execSandboxed({
          argv: [process.execPath, BOOTSTRAP, ctx.workspaceDir, scriptPath, VENDOR_ROOT],
          cwd: ctx.workspaceDir,
          timeoutMs,
          maxOutputBytes: OUTPUT_CAP_BYTES,
          env: { ELECTRON_RUN_AS_NODE: '1' },
          abortSignal: ctx.abortSignal,
        });
        // 子进程启动失败（spawn error：exitCode null 且既非超时也非中止）——
        // 文件不可能生成，跳过 outputs 记账循环（Task 2 审查增强）
        const spawnFailed = res.exitCode === null && !res.timedOut && !res.aborted;
        const lines = [
          `[run_js] 退出码=${res.exitCode === null ? 'null' : res.exitCode} 沙箱=${res.spawnTag}` +
            `${res.timedOut ? '（超时已强杀——缩小脚本或分批跑）' : ''}${res.aborted ? '（已中止）' : ''}`,
        ];
        if (res.stdout) lines.push('--- stdout ---', res.stdout);
        if (res.stderr) lines.push('--- stderr ---', res.stderr);
        if (res.truncated) lines.push('（输出超限已截断）');
        if (spawnFailed) lines.push('（子进程启动失败——检查报错信息）');
        if (!spawnFailed && tracked.length > 0) {
          lines.push('--- 产物记账 ---');
          for (const t of tracked) {
            const after = fs.existsSync(t.abs) ? fs.readFileSync(t.abs) : null;
            if (after === null) { lines.push(`${t.rel}: 未生成（不记账）`); continue; }
            const op = t.before === null ? 'create' : 'modify';
            if (typeof ctx.recordFileChange === 'function') {
              ctx.recordFileChange('plugin:office-pro/run_js', t.rel, op, t.before, after);
            }
            if (ctx.readTracker && typeof ctx.readTracker.add === 'function') {
              ctx.readTracker.add(ctx.roomId, t.abs, ctx.parentStreamSessionId);
            }
            lines.push(`${t.rel}: ${op}${typeof ctx.recordFileChange === 'function' ? ' 已记账（可撤销）' : '（记账不可用）'}`);
          }
          lines.push('（未列入 outputs 的写入不入账——与 bash 对等；请声明全部产物）');
        }
        return lines.filter((l) => l !== '').join('\n');
      } finally {
        try { fs.unlinkSync(scriptPath); } catch { /* tmp 清理失败无碍 */ }
      }
    },
  };
};
