// electron/tests/agent/tools/shell-tools.test.ts
//
// ShellTools 单元测试：bash 正常执行 + 超时 + 黑名单 + 输出截断，共 10 条。
// 设计要点：
//   - 每条用例用唯一 tmp 目录 + 真实 WorkspaceFS（路径沙箱走真实代码路径）。
//   - 构造最小 ToolContext：ShellTools 只用 wsFs / workspaceDir，其他字段给 stub。
//   - 黑名单用例直接期待 reject（命令在 spawn 前被 assertCommandAllowed 拦下）。
//   - 超时用例 vitest 超时给 10s（远大于 timeoutMs=1000，避免 CI 抖动）。
//   - 环境变量白名单用例：临时往 process.env 写 OPENAI_API_KEY，验证子进程不可见；
//     用例末尾 delete 清理；afterEach 再兜底清理一次避免失败时泄漏。
// v2.5 工具链机制整体移除（2026-10-04）：net-trust payload 仅 {netOn, extraDirs}
// 两字段，toolchainOn 已从契约下线。__setNetQueryForTest 替身形状相应精简。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { ShellTools } from '../../../src/main/agent/tools/shell-tools';
import { __setSandboxStateForTest } from '../../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../../src/main/sandbox/settings';
import {
  __setBashWriteWaitForTest,
  __setNetQueryForTest,
} from '../../../src/main/agent/tools/shell-tools';
import { WRITE_BLOCKED_HINT } from '../../../src/main/agent/tools/sandbox-write-hint';

/** 测试用 settings 构造器：v2.5 起 SandboxSettings 仅含 mode/networkPolicy */
function settings(mode: 'strict' | 'permissive', networkPolicy: 'deny' | 'allow') {
  return { mode, networkPolicy };
}

let tmpRoot: string;
let tmpDir: string;
let wsFs: WorkspaceFS;
let ctx: ToolContext;

  beforeEach(() => {
  // 每用例唯一 tmpDir，避免模块级缓存串数据。
  tmpRoot = path.join(os.tmpdir(), `ap-shell-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(tmpDir, { recursive: true });
  wsFs = new WorkspaceFS(tmpDir);
  // v2.4：bash 走 resolveShellSpawn（默认 strict + 未探测 → blocked 抛错）。
  // 注入 permissive + linux 沙箱不可用状态 → plain 直跑 + unsandboxed 标记。
  __setSandboxSettingsForTest(settings('permissive', 'deny'));
  __setSandboxStateForTest({
    platform: 'linux', sandboxTool: null, toolVersion: null,
    available: false, unavailableReason: 'bwrap 未安装', windowsShell: null,
    executionPolicy: null, probedAt: 0,
  });
  // ShellTools 只用 wsFs / workspaceDir；其他字段给空 stub（实现不会触碰）。
  ctx = {
    wsFs,
    workspaceId: 'test-ws',
    workspaceDir: tmpDir,
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: ['bash'], deniedTools: [] },
    creatorUserId: '',
  };
});

afterEach(() => {
  // 沙箱钩子复位（模块级单例，防泄漏到其他测试文件外的用例）
  __setSandboxSettingsForTest(null);
  __setSandboxStateForTest(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  // 兜底：防止 OPENAI_API_KEY 用例失败时泄漏到后续用例。
  delete process.env.OPENAI_API_KEY;
});

describe('bash 正常执行', () => {
  it('简单 echo', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'echo hello' }, ctx);
    expect(result).toContain('exit_code: 0');
    // v2.4：结果第二行固定为 sandbox 标记（permissive 降级 = unsandboxed:原因）
    expect(result).toContain('sandbox: unsandboxed:bwrap 未安装');
    expect(result).toContain('hello');
  });

  it('退出码非 0 不抛错', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'exit 42' }, ctx);
    expect(result).toContain('exit_code: 42');
    expect(result).toContain('sandbox: unsandboxed:bwrap 未安装');
  });

  it('工作目录锁定 workspace 根', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'pwd' }, ctx);
    expect(result).toContain(tmpDir);
  });

  it('环境变量含 WORKSPACE_DIR 不含 OPENAI_API_KEY', async () => {
    process.env.OPENAI_API_KEY = 'secret-key-for-test';
    const tools = new ShellTools();
    const result = await tools.execute('bash',
      { command: 'echo WORKSPACE=$WORKSPACE_DIR SK=$OPENAI_API_KEY' }, ctx);
    expect(result).toContain(`WORKSPACE=${tmpDir}`);
    expect(result).not.toContain('secret-key-for-test');
    delete process.env.OPENAI_API_KEY;
  });
});

describe('bash 超时', () => {
  it('自定义 timeoutMs 超时', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'sleep 5', timeoutMs: 1000 }, ctx);
    expect(result).toContain('超时');
    // 超时路径（close 事件触发）同样带 sandbox 标记
    expect(result).toContain('sandbox: unsandboxed:');
  }, 10000);
});

describe('bash 黑名单', () => {
  it('rm -rf / 抛错', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: 'rm -rf /' }, ctx)).rejects.toThrow(/黑名单/);
  });

  it('mkfs 抛错', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: 'mkfs.ext4 /dev/sda' }, ctx)).rejects.toThrow(/黑名单/);
  });

  it('fork bomb 抛错', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: ':(){ :|:& };:' }, ctx)).rejects.toThrow(/黑名单/);
  });

  it('rm -rf ./dist 不误伤', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'dist'));
    await fs.promises.writeFile(path.join(tmpDir, 'dist/x'), '');
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'rm -rf ./dist' }, ctx);
    expect(result).toContain('exit_code: 0');
    expect(fs.existsSync(path.join(tmpDir, 'dist'))).toBe(false);
  });

  it('git commit 走 bash 被拦截', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: 'git commit -m test' }, ctx)).rejects.toThrow(/git_commit/);
  });

  // v2.4.0 review 修补：Remove-Item 黑名单必须覆盖双向语序。
  // win32 无 OS 沙箱，黑名单是唯一防线——只拦一种语序会被 PowerShell 习惯写法绕过。
  it('拦截 Remove-Item 路径在前语序（-Path C:\\ -Recurse）', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: 'Remove-Item -Path C:\\ -Recurse' }, ctx))
      .rejects.toThrow(/递归删除盘根/);
  });

  it('拦截 Remove-Item flag 在前语序（-Recurse -Path C:\\）', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: 'Remove-Item -Recurse -Path C:\\' }, ctx))
      .rejects.toThrow(/递归删除盘根/);
  });

  it('不误伤 workspace 相对路径（Remove-Item ./dist -Recurse）', async () => {
    // 控制用例：双向放宽不能引入误伤；只校验「未被黑名单拦下」。
    // 注：linux 下 Remove-Item 不是合法 sh 命令，spawn 后会失败——错误必须不含「黑名单」。
    const tools = new ShellTools();
    try {
      await tools.execute('bash', { command: 'Remove-Item ./dist -Recurse' }, ctx);
    } catch (e) {
      expect((e as Error).message).not.toMatch(/黑名单/);
    }
  });
});

describe('bash 输出截断', () => {
  it('stdout 超 10KB 截断', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'yes hello | head -2000' }, ctx);
    expect(result).toContain('截断');
  });
});

// v2.5 HOME 写拦截提示层（spec §7）：真跑集成——bash 结果尾部追加固定提示，
// 同服 LLM（知道该请求用户授权而非绕路）与 renderer stream.store（固定子串
// 检测置引导卡）。提示判定纯函数的三条件矩阵（平台无关）见
// sandbox-write-hint.test.ts；此处锁 shell-tools 结果组装层的真跑接线。
// seatbelt 真跑仅 darwin（linux 容器无 bwrap 时 wrapped 分支不可达）——
// itDarwin 门控跳过其余平台，非沙箱 tag 的负控制例两平台均可跑。
const itDarwin = process.platform === 'darwin' ? it : it.skip;
/** 与真实 rustup 失败同形的 stderr 签名（locale 无关——写死文案而非依赖 strerror） */
const WRITE_BLOCKED_CMD = "echo 'error: could not write to ~/.rustup: Operation not permitted' >&2; exit 1";

describe('bash HOME 写拦截提示层（spec §7）', () => {
  itDarwin('沙箱 tag + EPERM 签名 + HOME 特征 → 结果尾部逐字追加 WRITE_BLOCKED_HINT', async () => {
    // strict + seatbelt 可用 + 网络回退推导 allow（非 fork 环境桥不可用）→ wrapped seatbelt/net-on
    __setSandboxSettingsForTest(settings('strict', 'allow'));
    __setSandboxStateForTest({
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    // spec hard-gate §5 等待循环：非 fork 环境 process.send 缺省 → wait 短路 denied →
    // 走 formatWriteDeniedResult 分支，bashOnce 文本不可见。此处注入 wait 替身返
    // 回 covered 让等待循环正常推进；bashOnce 仍持续被拦 → MAX_ROUNDS 后落出，
    // 末轮 last.text 仍带 sandbox tag + hint（bashOnce 自身负责追加 hint）。
    __setBashWriteWaitForTest({ wait: async () => ({ kind: 'covered' as const }) });
    try {
      const tools = new ShellTools();
      const result = await tools.execute('bash', { command: WRITE_BLOCKED_CMD }, ctx);
      expect(result).toContain('sandbox: seatbelt/net-on');
      // 提示逐字追加在结果尾部（最后一段——LLM 最后看到，行动指引优先级最高）
      expect(result.endsWith(WRITE_BLOCKED_HINT)).toBe(true);
      expect(result).toContain('工作空间外路径写入被沙箱拦截');
      expect(result).toContain('请勿用临时目录或缓存重定向绕过');
    } finally {
      __setBashWriteWaitForTest(null);
    }
  });

  it('非沙箱 tag（permissive 降级 unsandboxed）→ 同签名不追加提示（负控制）', async () => {
    // beforeEach 已注入 permissive + 不可用 → plain 直跑 unsandboxed:原因
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: WRITE_BLOCKED_CMD }, ctx);
    expect(result).toContain('sandbox: unsandboxed:bwrap 未安装');
    expect(result).not.toContain('工作空间外路径写入被沙箱拦截');
  });
});

// 进程组上报（2026-09-25 生命周期立项）：spawn 成功后经 child IPC 上报 pgid，
// 主进程 registry 是回合收割的唯一真相源。单测环境 process.send 缺省为
// undefined——临时替换捕获载荷，finally 恢复。
describe('bash 进程组上报（proc-group:register）', () => {
  it('spawn 成功后上报 streamSessionId + pgid', async () => {
    const sent: unknown[] = [];
    const origSend = process.send;
    (process as { send?: (msg: unknown) => boolean }).send = (msg: unknown) => {
      // net-trust 桥请求抛错让桥快速 reject（真实子进程有主进程应答；测试环境
      // 无桥——吞掉请求会让桥等到超时，见 net-trust-bridge.ts sendNetTrustOp）
      if ((msg as { type?: string }).type === 'net-trust-op') {
        throw new Error('测试环境无 net-trust 桥');
      }
      sent.push(msg);
      return true;
    };
    try {
      const res = await new ShellTools().execute('bash', { command: 'true' }, ctx);
      expect(res).toContain('exit_code: 0');
      const reg = sent.find(
        (m) => (m as { type?: string }).type === 'proc-group:register',
      ) as { streamSessionId?: string; pgid?: number } | undefined;
      expect(reg).toBeDefined();
      expect(reg!.streamSessionId).toBe('test-stream');
      expect(typeof reg!.pgid).toBe('number');
    } finally {
      (process as { send?: (msg: unknown) => boolean }).send = origSend;
    }
  });
});


// ═══ 写授权硬门控等待（spec 2026-10-03 hard-gate §5）═══
describe('bash 写授权硬门控等待（spec hard-gate §5）', () => {
  const HOME_TARGET = path.join(os.homedir(), `.momo-wait-verify-${process.pid}`);
  const REAL_BLOCKED_CMD = `echo granted >> ${HOME_TARGET}`;

  const capturedSends: Array<Record<string, unknown>> = [];
  const realSend = process.send;

  beforeEach(() => {
    capturedSends.length = 0;
    Object.defineProperty(process, 'send', {
      value: (msg: unknown): boolean => {
        capturedSends.push(msg as Record<string, unknown>);
        return true;
      },
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process, 'send', { value: realSend, configurable: true });
    __setBashWriteWaitForTest(null);
    __setNetQueryForTest(null);
    try { fs.rmSync(HOME_TARGET, { force: true }); } catch { /* best-effort */ }
  });

  itDarwin('真被拦 → 上报 write-blocked-report → covered 后重执行成功（无缝续跑）', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    __setSandboxStateForTest({
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    // 桥替身：首查无授权（真拦截），等待回调翻转 extraDirs（= 用户点了授权卡）
    __setNetQueryForTest(async () => ({ netOn: false, extraDirs: [] }));
    __setBashWriteWaitForTest({
      wait: async (o) => {
        // 模拟授权落地：下一次 effective 返回已授权目录
        __setNetQueryForTest(async () => ({ netOn: false, extraDirs: [path.join(os.homedir(), path.basename(HOME_TARGET))] }));
        void o.isCovered();
        return { kind: 'covered' as const };
      },
    });
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: REAL_BLOCKED_CMD }, ctx);
    // 上报形状（fire-and-forget，照 proc-group:register 形态）
    const report = capturedSends.find((m) => m.type === 'write-blocked-report');
    expect(report).toBeDefined();
    expect(report?.dirs).toEqual([HOME_TARGET]);
    expect(report?.command).toBe(REAL_BLOCKED_CMD);
    // 重执行成功：exit 0、无提示段、文件真写入
    expect(result).toContain('exit_code: 0');
    expect(result).not.toContain('工作空间外路径写入被沙箱拦截');
    expect(fs.existsSync(HOME_TARGET)).toBe(true);
  });

  itDarwin('denied → 返回统一拒绝文案（无 hint、无重执行）', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    __setSandboxStateForTest({
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    __setNetQueryForTest(async () => ({ netOn: false, extraDirs: [] }));
    __setBashWriteWaitForTest({ wait: async () => ({ kind: 'denied' as const }) });
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: WRITE_BLOCKED_CMD }, ctx);
    // dirs 形态取决于 WRITE_BLOCKED_CMD 的路径提取——锁前缀语义，不锁具体目录
    expect(result).toMatch(/^用户已拒绝授权（目录：.+）。请勿重试同一目标；如确需写入请与用户协商其他方案。$/);
    expect(result).not.toContain('工作空间外路径写入被沙箱拦截');
    expect(capturedSends.filter((m) => m.type === 'write-blocked-report')).toHaveLength(1);
  });

  itDarwin('covered 但重执行仍被拦（新目录）→ 循环再等待；denied 收敛', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    __setSandboxStateForTest({
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    __setNetQueryForTest(async () => ({ netOn: false, extraDirs: [] }));
    let waitCalls = 0;
    __setBashWriteWaitForTest({
      wait: async () => {
        waitCalls += 1;
        return waitCalls <= 1 ? { kind: 'covered' as const } : { kind: 'denied' as const };
      },
    });
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: WRITE_BLOCKED_CMD }, ctx);
    expect(waitCalls).toBe(2);
    expect(result).toContain('用户已拒绝授权');
    expect(capturedSends.filter((m) => m.type === 'write-blocked-report').length).toBeGreaterThanOrEqual(2);
  });

  itDarwin('回归锁 bug ①：被拦目录不在 extraDirs → isCovered 必须为 false（纯成员判定）', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    __setSandboxStateForTest({
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    // v2.5 工具链机制移除后 net-trust payload 仅 {netOn, extraDirs}——无 toolchainOn
    // 字段。被拦目录不在 extraDirs 时 isCovered 必须为 false（纯成员判定），否则
    // 任何被拦目录都会瞬判 covered 零询问用户（bug ① 的根因形态）。
    __setNetQueryForTest(async () => ({ netOn: false, extraDirs: [] }));
    let probe: boolean | undefined;
    __setBashWriteWaitForTest({
      wait: async (o) => {
        probe = await o.isCovered();
        return { kind: 'denied' as const };
      },
    });
    const tools = new ShellTools();
    await tools.execute('bash', { command: WRITE_BLOCKED_CMD }, ctx);
    expect(probe).toBe(false); // 旧代码此处为 true（toolchainOn || 短路）——瞬判 covered 零等待
  });
});

// isCovered 源码锁（spec hard-gate §4.2）：防止 bug ① 复活——纯成员判定语义必须
// 永久保留。v2.5 工具链机制移除后 toolchainOn 整字段已下线（任何形式的复活都属
// 重新引入瞬断路径），因此本锁扩展为「源码不得再出现 eff.toolchainOn 这一整段」
// ——既锁逻辑形态，又锁字段复活。
describe('isCovered 源码锁（spec hard-gate §4.2）', () => {
  it('不再以 eff.toolchainOn 作覆盖判定（bug ① 防复活 + toolchainOn 字段防复活）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/main/agent/tools/shell-tools.ts'),
      'utf-8',
    );
    expect(src).not.toContain('eff.toolchainOn ||');
    expect(src).not.toContain('eff.toolchainOn');
  });
});
