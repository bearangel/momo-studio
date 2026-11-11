# 亿赛通加密环境文件代理读写（File IO Proxy）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **执行前必加载的项目技能**：全任务 `momo-test-rules`（测试保真度）；Task 5/7 `momo-boundary-rules`（跨模块契约）；Task 8 `momo-ui-preview-rules`（UI 预览门禁）。

**Goal:** 让 momo-studio 在亿赛通透明加密环境中正常读写受控源码文件（文件面板 + agent 工具全链路），读得明文、写入落盘为合规密文。

**Architecture:** 主进程持有单例 `FileIoService`，懒启动一个常驻 `node.exe` 代理 worker（亿赛通白名单进程）；`WorkspaceFS` 的 `readFile/writeFile/createFile` 经模块级 `ContentIo` 路由——direct 走本地 fs，proxy 走 worker；runtime 子进程（fork 出的 momo-studio.exe 镜像、非白名单）经 `file-io-bridge`（id 配对 IPC，同构 process-bridge）转发到主进程。密文读到即硬失败 `EENCRYPTED`。

**Tech Stack:** TypeScript strict（CommonJS 主进程）· Electron 44 · better-sqlite3（设置）· vitest（electron/tests + renderer 贴源）· 原生 Node（worker 脚本无依赖，Node ≥ 14 兼容）

**Spec:** `docs/specs/2026-11-11-esafenet-fileio-proxy-design.md`

---

## Global Constraints

- **TypeScript strict**：禁止 `any` / `as any` / `@ts-ignore` / `@ts-expect-error`（ESLint error 级）。
- **注释与文档中文**；代码标识符英文。
- **`electron/src/main/files/file-io/` 下除 `ipc.handlers.ts` 外禁止 `import 'electron'`**——bridge / content-io / service 会被 runtime 子进程加载（`git-policy.ts` 先例）。需要 electron API 时用 `loadElectronApis()` 惰性取用。
- **worker 脚本 Node ≥ 14 兼容**：不得使用 `??=`、`Array.prototype.at`、`fs.rmSync`、top-level await、`AbortController`；不得 require 任何 npm 包。
- **spawn worker 时 `env` 必须完整继承 `process.env`（PATH 原样透传）**——亿赛通向白名单进程注入 `DynamicDll64.dll` 且按 PATH 加载，裁剪 PATH = `0xc0000135` 崩溃（vcpkg 实证）。专项回归测试锁死（Task 4）。
- **UI 文案中性化**：用户可见文案不得出现「亿赛通 / E-SafeNet / 安全部门 / 合规批准」等厂商与审批口径字样，「白名单」改用「放行」表述；「加密」作为纯技术事实词允许；技术细节只落 `logger`。错误文案使用 `types.ts` 中常量。
- **不做静默降级**：proxy 失败必须 `EENCRYPTED` / 错误码显式抛出，绝不回退 direct 继续读。
- **默认 `direct`**；未加密环境零行为变化。
- **测试位置**：主进程 `electron/tests/`（镜像 src 结构，`tests/files/file-io/`）；renderer 贴源 colocated。根 `tests/` 只放 Playwright。
- **命令**：容器内先 `nvm use 24`。单文件测试 `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/xxx.test.ts`；renderer `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/FileIoSettingsPanel.test.tsx`；类型检查 `npx pnpm@9.0.0 typecheck`（根）。
- **Conventional Commits**（feat/fix/test/refactor/docs）；**不动三处 package.json 版本号**。
- preload 改动引用 `renderer/src/ipc/types.d.ts`（三层 `../../../`）——改 IPC 面后**两个 workspace 都要 typecheck**。

## Review Focus

以下五类输入/故障是 spec 明确要求、但最容易被实现漏掉的，均已钉到对应任务的测试：

1. **worker 的 PATH 被裁剪**（注入 DLL 加载失败崩溃）→ Task 4 `env 完整继承` 专项断言（spawnImpl 捕获 opts.env 与 `process.env` 比对）。
2. **direct 模式读到密文仍静默返回乱码**（后续错误离真相十万八千里）→ Task 1 魔数单测 + Task 4/5 `EENCRYPTED` 硬失败测试。
3. **worker 死亡后请求挂死或静默降级**→ Task 4 `die` 后 `ECHILD` + 紧随请求自愈重启成功。
4. **大批量读（>batchSize）丢序/丢文件**→ Task 4 120 文件 batch=50 → 3 批、结果按序完整。
5. **`process.send` 解构裸调用在严格模式崩溃（2.0.0 P0-1 教训）**→ Task 7 桥用方法调用形式发送 + 非 fork 环境立即 reject（不挂等）。

---

## Task 1: 基础类型与密文检测

**Files:**
- Create: `electron/src/main/files/file-io/types.ts`
- Create: `electron/src/main/files/file-io/cipher-detect.ts`
- Test: `electron/tests/files/file-io/cipher-detect.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `FileIoMode` / `EffectiveFileIoMode` / `FileIoErrorCode` / `class FileIoError { code }` / `interface ContentIo` / 常量 `MSG_DIRECT_CIPHER` `MSG_PROXY_CIPHER`；`looksEncrypted(buf: Buffer | null | undefined): boolean`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/files/file-io/cipher-detect.test.ts
import { describe, expect, it } from 'vitest';
import { looksEncrypted } from '../../../src/main/files/file-io/cipher-detect';
import { FileIoError, MSG_DIRECT_CIPHER, MSG_PROXY_CIPHER } from '../../../src/main/files/file-io/types';

// 真实密文头（上游 PoC §1.1 实测）：62 14 23 65 DA 00 ... "E-SafeNet" ... "LOCK"
const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

describe('looksEncrypted', () => {
  it('空/过短缓冲返回 false', () => {
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
    expect(looksEncrypted(Buffer.alloc(0))).toBe(false);
    expect(looksEncrypted(Buffer.alloc(11))).toBe(false);
  });

  it('真实密文头命中', () => {
    expect(looksEncrypted(CIPHER_HEAD)).toBe(true);
  });

  it('魔数出现在 64 字节之后不算', () => {
    const buf = Buffer.alloc(96, 0x20);
    buf.write('E-SafeNet', 70, 'latin1');
    expect(looksEncrypted(buf)).toBe(false);
  });

  it('普通源码文本不误报', () => {
    expect(looksEncrypted(Buffer.from('package com.ecs.dape;\n', 'utf8'))).toBe(false);
  });
});

describe('FileIoError 与文案常量', () => {
  it('携带 code 且 instanceof Error', () => {
    const e = new FileIoError('EENCRYPTED', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('EENCRYPTED');
    expect(e.name).toBe('FileIoError');
  });

  it('错误文案中性化（不含敏感字样）', () => {
    for (const msg of [MSG_DIRECT_CIPHER, MSG_PROXY_CIPHER]) {
      expect(msg).not.toMatch(/亿赛通|白名单|安全部门|合规/);
      expect(msg).toContain('设置 → 文件访问');
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/cipher-detect.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/files/file-io/types.ts
//
// File IO Proxy 公共类型（spec 2026-11-11 §5）。本文件及同目录其它模块会被
// runtime 子进程加载——禁止 import 'electron'。
export type FileIoMode = 'direct' | 'proxy' | 'auto';
export type EffectiveFileIoMode = 'direct' | 'proxy';

export type FileIoErrorCode =
  | 'EENCRYPTED'
  | 'ENONODE'
  | 'ENOWORKER'
  | 'ESPAWN'
  | 'ECHILD'
  | 'ETIMEOUT'
  | 'EREAD'
  | 'EWRITE'
  | 'EBADMODE';

/** 文件 IO 领域错误：code 沿 IPC / 桥全线透传（错误契约见 spec §5.7） */
export class FileIoError extends Error {
  constructor(readonly code: FileIoErrorCode, message: string) {
    super(message);
    this.name = 'FileIoError';
  }
}

/**
 * 文件内容读写通道（WorkspaceFS 收口注入点，spec §5.3）。
 * absPath 已由 WorkspaceFS.assertInWorkspace 校验为绝对路径。
 */
export interface ContentIo {
  readFile(absPath: string): Promise<Buffer>;
  writeFile(absPath: string, data: Buffer): Promise<void>;
}

// ── 用户可见错误文案（硬性约束：中性化，见 spec §5.6；技术细节只进日志）──
export const MSG_DIRECT_CIPHER =
  '文件为加密格式，无法读取。请在 设置 → 文件访问 切换为 Node 代理模式，或联系管理员。';
export const MSG_PROXY_CIPHER =
  'Node 代理模式下仍读到加密内容。代理进程可能未被放行，请检查本机安全策略或联系管理员。';
```

```typescript
// electron/src/main/files/file-io/cipher-detect.ts
//
// E-SafeNet 容器魔数检测（上游 PoC §9.3「黄金标准」）：前 64 字节是否含
// "E-SafeNet"。direct 读到它 = 通道不对，必须硬失败（spec §5.3）。
const CIPHER_MAGIC = Buffer.from('E-SafeNet', 'latin1');

/** 判断字节流是否为亿赛通加密容器 */
export function looksEncrypted(buf: Buffer | null | undefined): boolean {
  if (!buf || buf.length < 12) return false;
  return buf.subarray(0, 64).indexOf(CIPHER_MAGIC) !== -1;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/cipher-detect.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/files/file-io/types.ts electron/src/main/files/file-io/cipher-detect.ts electron/tests/files/file-io/cipher-detect.test.ts
git commit -m "feat(files): file-io 基础类型与密文魔数检测"
```

---

## Task 2: 设置字段与模式解析

**Files:**
- Modify: `electron/src/main/settings/crud.ts`（`GlobalSettings` 接口 + `getGlobalSettings` 透传）
- Create: `electron/src/main/files/file-io/file-io-settings.ts`
- Test: `electron/tests/files/file-io/file-io-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FileIoMode` / `EffectiveFileIoMode`
- Produces: `interface FileIoConfig { mode?; nodePath?; strictCipherCheck? }`；`interface ResolvedFileIoSettings { mode: FileIoMode; nodePath: string | null; strictCipherCheck: boolean }`；`ESAFENET_CLIENT_DIRS`；`detectClientInstalled(exists?): boolean`；`resolveFileIoSettings(raw?): ResolvedFileIoSettings`；`resolveEffectiveMode(s, clientInstalled): EffectiveFileIoMode`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/files/file-io/file-io-settings.test.ts
import { describe, expect, it } from 'vitest';
import {
  ESAFENET_CLIENT_DIRS,
  detectClientInstalled,
  resolveEffectiveMode,
  resolveFileIoSettings,
} from '../../../src/main/files/file-io/file-io-settings';

describe('resolveFileIoSettings', () => {
  it('缺省 direct + strictCipherCheck true + nodePath null', () => {
    expect(resolveFileIoSettings(undefined)).toEqual({
      mode: 'direct',
      nodePath: null,
      strictCipherCheck: true,
    });
  });

  it('非法 mode 回退 direct（EBADMODE 不静默到 auto）', () => {
    // @ts-expect-error 故意传非法值验证防御
    expect(resolveFileIoSettings({ mode: 'hack' }).mode).toBe('direct');
  });

  it('显式 proxy / auto 保留；strictCipherCheck 仅显式 false 才关', () => {
    expect(resolveFileIoSettings({ mode: 'proxy' }).mode).toBe('proxy');
    expect(resolveFileIoSettings({ mode: 'auto' }).mode).toBe('auto');
    expect(resolveFileIoSettings({ strictCipherCheck: false }).strictCipherCheck).toBe(false);
  });

  it('空 nodePath 归 null', () => {
    expect(resolveFileIoSettings({ nodePath: '' }).nodePath).toBeNull();
    expect(resolveFileIoSettings({ nodePath: 'C:\\nodejs\\node.exe' }).nodePath).toBe(
      'C:\\nodejs\\node.exe',
    );
  });
});

describe('detectClientInstalled', () => {
  it('任一客户端目录存在即 true', () => {
    const target = ESAFENET_CLIENT_DIRS[0];
    expect(detectClientInstalled((p) => p === target)).toBe(true);
    expect(detectClientInstalled(() => false)).toBe(false);
  });

  it('exists 抛错视为未安装（不崩）', () => {
    expect(
      detectClientInstalled(() => {
        throw new Error('EACCES');
      }),
    ).toBe(false);
  });
});

describe('resolveEffectiveMode', () => {
  it('direct/proxy 原样；auto 按探测结果', () => {
    expect(resolveEffectiveMode(resolveFileIoSettings({ mode: 'direct' }), true)).toBe('direct');
    expect(resolveEffectiveMode(resolveFileIoSettings({ mode: 'proxy' }), false)).toBe('proxy');
    expect(resolveEffectiveMode(resolveFileIoSettings({ mode: 'auto' }), true)).toBe('proxy');
    expect(resolveEffectiveMode(resolveFileIoSettings({ mode: 'auto' }), false)).toBe('direct');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/file-io-settings.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/files/file-io/file-io-settings.ts
//
// fileIo 设置解析（spec §5.6）。纯函数 + 可注入探测，零 DB / electron 依赖。
import fs from 'node:fs';
import type { EffectiveFileIoMode, FileIoMode } from './types';

/** kv_store global_settings.fileIo 的原始形状（settings/crud.ts GlobalSettings.fileIo 同构） */
export interface FileIoConfig {
  mode?: FileIoMode;
  nodePath?: string;
  strictCipherCheck?: boolean;
}

export interface ResolvedFileIoSettings {
  mode: FileIoMode;
  nodePath: string | null;
  strictCipherCheck: boolean;
}

/** 加密客户端安装目录（auto 探测依据；上游 PoC §1.2 实测） */
export const ESAFENET_CLIENT_DIRS = ['C:\\Program Files\\EsafeNet\\Cobra DocGuard Client'];

/** 探测加密客户端是否安装；exists 可注入（测试） */
export function detectClientInstalled(
  exists: (p: string) => boolean = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
): boolean {
  return ESAFENET_CLIENT_DIRS.some((d) => exists(d));
}

export function resolveFileIoSettings(raw?: FileIoConfig): ResolvedFileIoSettings {
  const mode: FileIoMode =
    raw?.mode === 'proxy' || raw?.mode === 'auto' || raw?.mode === 'direct'
      ? raw.mode
      : 'direct';
  const nodePath =
    typeof raw?.nodePath === 'string' && raw.nodePath.trim().length > 0 ? raw.nodePath : null;
  return { mode, nodePath, strictCipherCheck: raw?.strictCipherCheck !== false };
}

/** auto：客户端已装 → proxy，否则 direct；显式模式原样返回 */
export function resolveEffectiveMode(
  s: ResolvedFileIoSettings,
  clientInstalled: boolean,
): EffectiveFileIoMode {
  if (s.mode === 'proxy') return 'proxy';
  if (s.mode === 'auto') return clientInstalled ? 'proxy' : 'direct';
  return 'direct';
}
```

修改 `electron/src/main/settings/crud.ts`：

```typescript
// 1) 文件头部 import 增加（放在既有 import 之后）：
import type { FileIoMode } from '../files/file-io/types';

// 2) GlobalSettings 接口内（journalQuotaMb 字段附近）新增：
  /**
   * 文件访问配置（spec 2026-11-11）。读侧只在 kv 有行时透传（缺省 undefined，
   * 缺省语义在 file-io-settings 解析）——此处给默认值会被 updateGlobalSettings
   * 的读改写合并烤进 JSON 污染判定（sandboxNetworkPolicy 先例）。
   */
  fileIo?: {
    mode?: FileIoMode;
    nodePath?: string;
    strictCipherCheck?: boolean;
  };

// 3) getGlobalSettings 的返回对象内（journalQuotaMb 一行附近）新增透传：
    fileIo: parsed.fileIo,
```

- [ ] **Step 4: 运行测试确认通过 + 类型检查**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/file-io-settings.test.ts`
Expected: PASS
Run: `npx pnpm@9.0.0 typecheck`（仓库根）
Expected: 0 error

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/settings/crud.ts electron/src/main/files/file-io/file-io-settings.ts electron/tests/files/file-io/file-io-settings.test.ts
git commit -m "feat(settings): fileIo 配置字段与模式解析"
```

---

## Task 3: io-worker 协议核心

**Files:**
- Create: `electron/src/main/files/file-io/io-worker.ts`
- Test: `electron/tests/files/file-io/io-worker.test.ts`

**Interfaces:**
- Consumes: 无（独立脚本）
- Produces: `WorkerRequest` / `WorkerItem` / `WorkerResponse`；`handleWorkerRequest(req): WorkerResponse`（纯函数，同步 IO）；`startWorkerLoop(input, output): void`；`require.main === module` 自启

协议（spec §5.5）：

```jsonc
// 请求：{ "id": 1, "op": "read" | "readMany" | "write" | "stat", "path"?, "paths"?, "dataBase64"? }
// 响应：{ "id": 1, "ok": true, "dataBase64"?, "size"?, "items"? } | { "id": 1, "ok": false, "error": { "code", "message" } }
```

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/files/file-io/io-worker.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleWorkerRequest } from '../../../src/main/files/file-io/io-worker';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ioworker-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('handleWorkerRequest', () => {
  it('read 返回 base64 + size', () => {
    const p = path.join(dir, 'a.java');
    fs.writeFileSync(p, 'class A {}');
    const r = handleWorkerRequest({ id: 7, op: 'read', path: p });
    expect(r).toMatchObject({ id: 7, ok: true, size: 10 });
    expect(Buffer.from(r.dataBase64!, 'base64').toString('utf8')).toBe('class A {}');
  });

  it('read 不存在的文件 → ok:false + 错误码透传', () => {
    const r = handleWorkerRequest({ id: 1, op: 'read', path: path.join(dir, 'none.java') });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('ENOENT');
  });

  it('readMany 保持入参顺序，单条失败不影响其余', () => {
    const p1 = path.join(dir, 'a.txt');
    fs.writeFileSync(p1, 'AAA');
    const r = handleWorkerRequest({
      id: 2,
      op: 'readMany',
      paths: [p1, path.join(dir, 'missing.txt')],
    });
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    expect(Buffer.from(r.items![0].dataBase64!, 'base64').toString('utf8')).toBe('AAA');
    expect(r.items![1].ok).toBe(false);
  });

  it('write 自动创建父目录并落盘', () => {
    const p = path.join(dir, 'nested', 'deep', 'B.java');
    const r = handleWorkerRequest({
      id: 3,
      op: 'write',
      path: p,
      dataBase64: Buffer.from('class B {}').toString('base64'),
    });
    expect(r).toMatchObject({ ok: true, size: 10 });
    expect(fs.readFileSync(p, 'utf8')).toBe('class B {}');
  });

  it('stat 返回 size', () => {
    const p = path.join(dir, 'c.txt');
    fs.writeFileSync(p, '12345');
    expect(handleWorkerRequest({ id: 4, op: 'stat', path: p })).toMatchObject({
      ok: true,
      size: 5,
    });
  });

  it('非法 op → EBADREQ（不崩）', () => {
    // @ts-expect-error 故意非法 op
    const r = handleWorkerRequest({ id: 5, op: 'explode' });
    expect(r).toMatchObject({ ok: false, error: { code: 'EBADREQ' } });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/io-worker.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/files/file-io/io-worker.ts
//
// 白名单代理进程脚本（spec §5.5）：由系统 node.exe 常驻启动（node 在亿赛通
// 白名单内，驱动层自动解密/加密——本脚本无感知）。
// 约束：Node >= 14 语法；不得 require 任何外部包；不得 import electron。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export interface WorkerRequest {
  id: number;
  op: 'read' | 'readMany' | 'write' | 'stat';
  path?: string;
  paths?: string[];
  dataBase64?: string;
}

export interface WorkerItem {
  ok: boolean;
  dataBase64?: string;
  size?: number;
  error?: { code: string; message: string };
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  dataBase64?: string;
  size?: number;
  items?: WorkerItem[];
  error?: { code: string; message: string };
}

function toErr(e: unknown): { code: string; message: string } {
  const err = e as NodeJS.ErrnoException;
  return {
    code: typeof err?.code === 'string' ? err.code : 'EUNKNOWN',
    message: err?.message ?? String(e),
  };
}

/**
 * 单请求处理（纯函数，便于单测）。同步 IO：批量由主进程按 batchSize 分片，
 * 单批 50 个小文件实测 < 1ms（上游 PoC §7.3），无需异步化。
 */
export function handleWorkerRequest(req: WorkerRequest): WorkerResponse {
  try {
    if (req.op === 'read' && typeof req.path === 'string') {
      const buf = fs.readFileSync(req.path);
      return { id: req.id, ok: true, dataBase64: buf.toString('base64'), size: buf.length };
    }
    if (req.op === 'readMany' && Array.isArray(req.paths)) {
      const items: WorkerItem[] = req.paths.map((p) => {
        try {
          const buf = fs.readFileSync(p);
          return { ok: true, dataBase64: buf.toString('base64'), size: buf.length };
        } catch (e) {
          return { ok: false, error: toErr(e) };
        }
      });
      return { id: req.id, ok: true, items };
    }
    if (req.op === 'write' && typeof req.path === 'string' && typeof req.dataBase64 === 'string') {
      fs.mkdirSync(path.dirname(req.path), { recursive: true });
      const buf = Buffer.from(req.dataBase64, 'base64');
      fs.writeFileSync(req.path, buf);
      return { id: req.id, ok: true, size: buf.length };
    }
    if (req.op === 'stat' && typeof req.path === 'string') {
      const st = fs.statSync(req.path);
      return { id: req.id, ok: true, size: st.size };
    }
    return { id: req.id, ok: false, error: { code: 'EBADREQ', message: `非法请求: ${String(req.op)}` } };
  } catch (e) {
    return { id: req.id, ok: false, error: toErr(e) };
  }
}

/** 逐行循环（真实入口；单测直接测 handleWorkerRequest，不跑本函数） */
export function startWorkerLoop(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): void {
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let req: WorkerRequest;
    try {
      req = JSON.parse(line) as WorkerRequest;
    } catch {
      return; // 非 JSON 行丢弃——协议不容错降级，但不能崩
    }
    output.write(`${JSON.stringify(handleWorkerRequest(req))}\n`);
  });
  rl.on('close', () => process.exit(0));
}

// 打包产物由 node.exe 直接执行（require.main 守卫：被 import 时不启动循环）
if (require.main === module) {
  startWorkerLoop(process.stdin, process.stdout);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/io-worker.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/files/file-io/io-worker.ts electron/tests/files/file-io/io-worker.test.ts
git commit -m "feat(files): 白名单 node worker 读写协议（read/readMany/write/stat）"
```

---

## Task 4: FileIoService（worker 生命周期 + 批量 + 硬失败）

**Files:**
- Create: `electron/src/main/files/file-io/file-io-service.ts`
- Create: `electron/tests/files/file-io/fixtures/fake-worker.js`
- Test: `electron/tests/files/file-io/file-io-service.test.ts`

**Interfaces:**
- Consumes: Task 1（`looksEncrypted` / `FileIoError` / 文案常量）、Task 2（`ResolvedFileIoSettings` / `resolveEffectiveMode` / `detectClientInstalled`）、Task 3（`WorkerResponse`）
- Produces: `findNodePath(nodePath: string | null): string`（ENONODE 抛错）；`class FileIoService`：
  - `constructor(opts: FileIoServiceOpts)`
  - `effectiveMode(): EffectiveFileIoMode`
  - `applySettings(s: ResolvedFileIoSettings): void`
  - `readFile(p: string): Promise<Buffer>` / `readFiles(paths: string[]): Promise<Buffer[]>`
  - `writeFile(p: string, data: Buffer): Promise<void>`
  - `close(): void`

- [ ] **Step 1: 写 fake worker 测试替身**

```javascript
// electron/tests/files/file-io/fixtures/fake-worker.js
//
// 与 io-worker 同协议的测试替身（真实子进程 + 真实 stdin/stdout——momo-test-rules
// 保真要求，不用简化 stub）。额外行为：
//   path 以 hang-now 结尾 → 永不应答（超时测试）
//   path 以 die-now 结尾  → 进程立即退出（ECHILD + 自愈测试）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function readOne(p) {
  try {
    const buf = fs.readFileSync(p);
    return { ok: true, dataBase64: buf.toString('base64'), size: buf.length };
  } catch (e) {
    return { ok: false, error: { code: e.code || 'EUNKNOWN', message: e.message } };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const p = typeof req.path === 'string' ? req.path : '';
  if (p.endsWith('hang-now')) return;
  if (p.endsWith('die-now')) {
    process.exit(1);
    return;
  }
  let resp;
  try {
    if (req.op === 'read') {
      resp = { id: req.id, ...readOne(p) };
    } else if (req.op === 'readMany') {
      resp = { id: req.id, ok: true, items: req.paths.map(readOne) };
    } else if (req.op === 'write') {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const buf = Buffer.from(req.dataBase64, 'base64');
      fs.writeFileSync(p, buf);
      resp = { id: req.id, ok: true, size: buf.length };
    } else if (req.op === 'stat') {
      resp = { id: req.id, ok: true, size: fs.statSync(p).size };
    } else {
      resp = { id: req.id, ok: false, error: { code: 'EBADREQ', message: 'bad op' } };
    }
  } catch (e) {
    resp = { id: req.id, ok: false, error: { code: e.code || 'EUNKNOWN', message: e.message } };
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
});
rl.on('close', () => process.exit(0));
```

- [ ] **Step 2: 写失败测试**

```typescript
// electron/tests/files/file-io/file-io-service.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileIoService, findNodePath } from '../../../src/main/files/file-io/file-io-service';
import type { ResolvedFileIoSettings } from '../../../src/main/files/file-io/file-io-settings';
import { MSG_DIRECT_CIPHER } from '../../../src/main/files/file-io/types';

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-worker.js');
const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

const DIRECT: ResolvedFileIoSettings = { mode: 'direct', nodePath: null, strictCipherCheck: true };
const PROXY: ResolvedFileIoSettings = { mode: 'proxy', nodePath: null, strictCipherCheck: true };

let dir: string;
const services: FileIoService[] = [];
function mkProxySvc(extra?: Partial<ConstructorParameters<typeof FileIoService>[0]) {
  const svc = new FileIoService({
    settings: PROXY,
    workerPath: FIXTURE,
    nodePathOverride: process.execPath,
    ...extra,
  });
  services.push(svc);
  return svc;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-fileio-'));
});
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('direct 模式', () => {
  it('读明文正常', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'hello');
    const svc = new FileIoService({ settings: DIRECT });
    services.push(svc);
    expect((await svc.readFile(p)).toString('utf8')).toBe('hello');
    expect(svc.effectiveMode()).toBe('direct');
  });

  it('读到密文 → EENCRYPTED 硬失败（中性文案）', async () => {
    const p = path.join(dir, 'Enc.java');
    fs.writeFileSync(p, CIPHER_HEAD);
    const svc = new FileIoService({ settings: DIRECT });
    services.push(svc);
    await expect(svc.readFile(p)).rejects.toMatchObject({ code: 'EENCRYPTED' });
    await expect(svc.readFile(p)).rejects.toThrow(MSG_DIRECT_CIPHER);
  });

  it('strictCipherCheck=false 时原样返回（逃生口）', async () => {
    const p = path.join(dir, 'Enc2.java');
    fs.writeFileSync(p, CIPHER_HEAD);
    const svc = new FileIoService({
      settings: { ...DIRECT, strictCipherCheck: false },
    });
    services.push(svc);
    expect((await svc.readFile(p)).equals(CIPHER_HEAD)).toBe(true);
  });

  it('写文件自动建父目录', async () => {
    const p = path.join(dir, 'x', 'y', 'B.java');
    const svc = new FileIoService({ settings: DIRECT });
    services.push(svc);
    await svc.writeFile(p, Buffer.from('class B {}'));
    expect(fs.readFileSync(p, 'utf8')).toBe('class B {}');
  });
});

describe('proxy 模式（真实子进程 + fake worker）', () => {
  it('读 / 写 / 批量读 roundtrip', async () => {
    const svc = mkProxySvc();
    const p1 = path.join(dir, 'One.java');
    await svc.writeFile(p1, Buffer.from('class One {}'));
    expect((await svc.readFile(p1)).toString('utf8')).toBe('class One {}');

    const p2 = path.join(dir, 'Two.java');
    fs.writeFileSync(p2, 'class Two {}');
    const bufs = await svc.readFiles([p1, p2]);
    expect(bufs.map((b) => b.toString('utf8'))).toEqual(['class One {}', 'class Two {}']);
  });

  it('批量 120 文件（batch=50）按序完整返回', async () => {
    const svc = mkProxySvc({ batchSize: 50 });
    const paths = Array.from({ length: 120 }, (_, i) => {
      const p = path.join(dir, `f${String(i).padStart(3, '0')}.txt`);
      fs.writeFileSync(p, `content-${i}`);
      return p;
    });
    const bufs = await svc.readFiles(paths);
    expect(bufs).toHaveLength(120);
    bufs.forEach((b, i) => expect(b.toString('utf8')).toBe(`content-${i}`));
  });

  it('proxy 仍读到密文 → EENCRYPTED', async () => {
    const svc = mkProxySvc();
    const p = path.join(dir, 'Enc.java');
    fs.writeFileSync(p, CIPHER_HEAD);
    await expect(svc.readFile(p)).rejects.toMatchObject({ code: 'EENCRYPTED' });
  });

  it('spawn 的 env 完整继承 process.env（PATH 约束回归锁）', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const svc = new FileIoService({
      settings: PROXY,
      workerPath: FIXTURE,
      nodePathOverride: process.execPath,
      spawnImpl: (cmd, args, opts) => {
        capturedEnv = opts.env;
        return spawn(cmd, args, opts);
      },
    });
    services.push(svc);
    const p = path.join(dir, 'env.txt');
    fs.writeFileSync(p, 'x');
    await svc.readFile(p);
    expect(capturedEnv).toBe(process.env); // 引用相同——不经任何复制/sanitize
    expect(capturedEnv?.PATH ?? capturedEnv?.Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it('worker 被杀 → 在途请求 ECHILD，随后请求自愈重启成功', async () => {
    const svc = mkProxySvc();
    const normal = path.join(dir, 'ok.txt');
    fs.writeFileSync(normal, 'ok');
    await svc.readFile(normal); // 确保 worker 已启动
    const diePath = path.join(dir, 'die-now.txt');
    await expect(svc.readFile(diePath)).rejects.toMatchObject({ code: 'ECHILD' });
    // 自愈：下一次请求重新 spawn
    expect((await svc.readFile(normal)).toString('utf8')).toBe('ok');
  });

  it('超时', async () => {
    const svc = mkProxySvc({ timeoutMs: 150 });
    const hang = path.join(dir, 'hang-now.txt');
    await expect(svc.readFile(hang)).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });
});

describe('node 解析', () => {
  it('显式 nodePath 无效 → ENONODE（不回退 PATH）', () => {
    expect(() => findNodePath(path.join(dir, 'nope', 'node'))).toThrowError(
      expect.objectContaining({ code: 'ENONODE' }),
    );
  });

  it('null → 找到可用 node（测试进程自身）', () => {
    expect(fs.existsSync(findNodePath(null))).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/file-io-service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

```typescript
// electron/src/main/files/file-io/file-io-service.ts
//
// FileIoService（spec §5.8）：主进程单例持有，懒启动常驻 node.exe worker。
// 设计要点（上游 PoC 实测结论）：
//   - 常驻复用：每次 spawn 142ms 冷启动，逐请求 spawn 不可用
//   - 批量：batchSize=50 摊薄 IPC（2.51x → 1.39x）
//   - 密文硬失败：读到 E-SafeNet 立即 EENCRYPTED，绝不静默降级
//   - env 原样继承：亿赛通注入 DLL 经 PATH 加载（裁剪即 0xc0000135）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { looksEncrypted } from './cipher-detect';
import {
  FileIoError,
  MSG_DIRECT_CIPHER,
  MSG_PROXY_CIPHER,
  type EffectiveFileIoMode,
} from './types';
import {
  detectClientInstalled,
  resolveEffectiveMode,
  type ResolvedFileIoSettings,
} from './file-io-settings';
import type { WorkerResponse } from './io-worker';

export interface FileIoServiceOpts {
  settings: ResolvedFileIoSettings;
  /** worker 脚本绝对路径（默认同目录编译产物 io-worker.js；测试注入 fixture） */
  workerPath?: string;
  /** 覆盖 node 解析（测试注入） */
  nodePathOverride?: string;
  timeoutMs?: number;
  batchSize?: number;
  /** 客户端安装探测注入（测试；默认真实探测） */
  clientInstalled?: boolean;
  logger?: { warn(msg: string, meta?: unknown): void; info(msg: string, meta?: unknown): void };
  /** spawn 注入（测试断言 env 继承；默认 child_process.spawn） */
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

const DEFAULT_WORKER_PATH = path.join(__dirname, 'io-worker.js');
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;

/** node 可用性验证（真跑一次——防「同名但不可执行」） */
function verifyNode(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false;
    const r = spawnSync(p, ['-e', 'process.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    return r.status === 0 && String(r.stdout).trim() === 'ok';
  } catch {
    return false;
  }
}

/**
 * 解析可用 node 可执行文件。优先级（上游 PoC §4.4）：
 * 显式 nodePath（无效即 ENONODE，不回退）→ 自身 execPath 若为 node → PATH → 常见安装位。
 */
export function findNodePath(nodePath: string | null): string {
  if (nodePath !== null) {
    if (verifyNode(nodePath)) return nodePath;
    throw new FileIoError('ENONODE', `配置的 Node.js 路径不可用: ${nodePath}`);
  }

  const win = process.platform === 'win32';
  const exeName = win ? 'node.exe' : 'node';
  const candidates: string[] = [];

  // vitest / node 直跑时 execPath 就是 node；打包 Electron 下是 momo-studio.exe，跳过
  if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) candidates.push(process.execPath);

  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exeName));
  }
  if (win) {
    candidates.push('C:\\Program Files\\nodejs\\node.exe', 'D:\\Program Files\\nodejs\\node.exe');
  }

  for (const c of candidates) {
    if (verifyNode(c)) return c;
  }
  throw new FileIoError(
    'ENONODE',
    '未找到可用的 Node.js。Node 代理模式需要系统中存在 node（安装 Node.js 或在 设置 → 文件访问 指定路径）。',
  );
}

interface PendingEntry {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class FileIoService {
  private settings: ResolvedFileIoSettings;
  private readonly workerPath: string;
  private readonly nodePathOverride: string | null;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly clientInstalled: boolean;
  private readonly logger: FileIoServiceOpts['logger'];
  private readonly spawnImpl: NonNullable<FileIoServiceOpts['spawnImpl']>;

  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingEntry>();
  private seq = 0;
  private buf = '';
  private cachedEffective: EffectiveFileIoMode | null = null;

  constructor(opts: FileIoServiceOpts) {
    this.settings = opts.settings;
    this.workerPath = opts.workerPath ?? DEFAULT_WORKER_PATH;
    this.nodePathOverride = opts.nodePathOverride ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.clientInstalled = opts.clientInstalled ?? detectClientInstalled();
    this.logger = opts.logger;
    this.spawnImpl = opts.spawnImpl ?? ((cmd, args, o) => spawn(cmd, args, o));
  }

  /** 设置变更入口（模式切换后清缓存；direct 时回收 worker） */
  applySettings(s: ResolvedFileIoSettings): void {
    this.settings = s;
    this.cachedEffective = null;
    if (this.effectiveMode() === 'direct') this.close();
  }

  effectiveMode(): EffectiveFileIoMode {
    if (this.cachedEffective === null) {
      this.cachedEffective = resolveEffectiveMode(this.settings, this.clientInstalled);
    }
    return this.cachedEffective;
  }

  async readFile(p: string): Promise<Buffer> {
    return (await this.readFiles([p]))[0];
  }

  async readFiles(paths: string[]): Promise<Buffer[]> {
    if (paths.length === 0) return [];
    if (this.effectiveMode() === 'direct') {
      return paths.map((p) => {
        let buf: Buffer;
        try {
          buf = fs.readFileSync(p);
        } catch (e) {
          throw new FileIoError('EREAD', `读取失败: ${p} — ${(e as Error).message}`);
        }
        this.assertNotCipher(buf, p, 'direct');
        return buf;
      });
    }

    await this.ensureWorker();
    const out = new Array<Buffer>(paths.length);
    for (let i = 0; i < paths.length; i += this.batchSize) {
      const chunk = paths.slice(i, i + this.batchSize);
      const resp = await this.request({ op: 'readMany', paths: chunk });
      if (!resp.ok || !Array.isArray(resp.items) || resp.items.length !== chunk.length) {
        throw new FileIoError('EREAD', '代理进程返回格式异常');
      }
      for (let j = 0; j < chunk.length; j++) {
        const item = resp.items[j];
        if (!item.ok || item.dataBase64 === undefined) {
          throw new FileIoError(
            (item.error?.code as FileIoError['code']) ?? 'EREAD',
            `读取失败: ${chunk[j]} — ${item.error?.message ?? '未知错误'}`,
          );
        }
        const buf = Buffer.from(item.dataBase64, 'base64');
        this.assertNotCipher(buf, chunk[j], 'proxy');
        out[i + j] = buf;
      }
    }
    return out;
  }

  async writeFile(p: string, data: Buffer): Promise<void> {
    if (this.effectiveMode() === 'direct') {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data);
      } catch (e) {
        throw new FileIoError('EWRITE', `写入失败: ${p} — ${(e as Error).message}`);
      }
      return;
    }
    await this.ensureWorker();
    const resp = await this.request({ op: 'write', path: p, dataBase64: data.toString('base64') });
    if (!resp.ok) {
      throw new FileIoError(
        (resp.error?.code as FileIoError['code']) ?? 'EWRITE',
        `写入失败: ${p} — ${resp.error?.message ?? '未知错误'}`,
      );
    }
  }

  /** 关闭 worker（app will-quit / 测试 teardown） */
  close(): void {
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child) {
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        // 已退出——忽略
      }
    }
    this.failAllPending('worker 已关闭');
    this.buf = '';
  }

  /** 密文硬失败（spec §5.3 最重要设计决策） */
  private assertNotCipher(buf: Buffer, p: string, mode: EffectiveFileIoMode): void {
    if (!this.settings.strictCipherCheck || !looksEncrypted(buf)) return;
    // 技术细节只进日志（UI 中性化约束）
    this.logger?.warn('读到加密容器内容（通道不对或策略变更）', { path: p, mode });
    throw new FileIoError(
      'EENCRYPTED',
      `${mode === 'direct' ? MSG_DIRECT_CIPHER : MSG_PROXY_CIPHER}（${p}）`,
    );
  }

  private async ensureWorker(): Promise<void> {
    if (this.child !== null && this.child.exitCode === null) return;
    if (this.starting !== null) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      const nodePath = this.nodePathOverride ?? findNodePath(this.settings.nodePath);
      if (!fs.existsSync(this.workerPath)) {
        this.starting = null;
        reject(new FileIoError('ENOWORKER', `worker 脚本不存在: ${this.workerPath}`));
        return;
      }

      let child: ChildProcess;
      try {
        // env 原样继承（硬约束）：注入 DLL 经 PATH 加载，禁止 sanitize
        child = this.spawnImpl(nodePath, [this.workerPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: process.env,
        });
      } catch (e) {
        this.starting = null;
        reject(new FileIoError('ESPAWN', `启动代理进程失败: ${(e as Error).message}`));
        return;
      }

      this.child = child;
      this.buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg: WorkerResponse;
          try {
            msg = JSON.parse(line) as WorkerResponse;
          } catch {
            continue;
          }
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg);
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => {
        this.logger?.warn('代理进程 stderr', { text: String(d).trim() });
      });
      child.on('error', (e) => {
        this.child = null;
        this.starting = null;
        this.failAllPending(`代理进程错误: ${e.message}`);
        reject(new FileIoError('ESPAWN', `代理进程错误: ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        this.child = null;
        this.starting = null;
        this.failAllPending(`代理进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
      });

      resolve();
    });
    return this.starting;
  }

  private request(payload: { op: string; path?: string; paths?: string[]; dataBase64?: string }): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      const child = this.child;
      if (child === null || child.exitCode !== null || !child.stdin) {
        reject(new FileIoError('ECHILD', '代理进程未就绪'));
        return;
      }
      const id = this.seq++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FileIoError('ETIMEOUT', `代理进程请求超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new FileIoError('ECHILD', `写代理进程失败: ${(e as Error).message}`));
      }
    });
  }

  private failAllPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new FileIoError('ECHILD', reason));
    }
    this.pending.clear();
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/file-io-service.test.ts`
Expected: PASS（13 用例）

- [ ] **Step 6: 提交**

```bash
git add electron/src/main/files/file-io/file-io-service.ts electron/tests/files/file-io/fixtures/fake-worker.js electron/tests/files/file-io/file-io-service.test.ts
git commit -m "feat(files): FileIoService 常驻 worker / 批量 / 密文硬失败 / 自愈"
```

---

## Task 5: ContentIo 与 WorkspaceFS 收口

**Files:**
- Create: `electron/src/main/files/file-io/content-io.ts`
- Modify: `electron/src/main/files/workspace-fs.ts`（构造函数 + `readFile`/`writeFile`/`createFile` 路由 + 模块默认通道）
- Test: `electron/tests/files/workspace-fs-content-io.test.ts`

**Interfaces:**
- Consumes: Task 1（`ContentIo` / `FileIoError` / `MSG_DIRECT_CIPHER` / `looksEncrypted`）
- Produces: `class DirectContentIo implements ContentIo`（`constructor(strictCipherCheck: boolean)`）；`class ProxyContentIo implements ContentIo`（`constructor(io: { readFile(p): Promise<Buffer>; writeFile(p, d): Promise<void> })`）；`WorkspaceFS` 新增 `constructor(rootDir: string, opts?: { contentIo?: ContentIo })`；模块导出 `setDefaultContentIo(io: ContentIo | null): void`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/files/workspace-fs-content-io.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFS, setDefaultContentIo } from '../../src/main/files/workspace-fs';
import { DirectContentIo } from '../../src/main/files/file-io/content-io';
import type { ContentIo } from '../../src/main/files/file-io/types';
import { MSG_DIRECT_CIPHER } from '../../src/main/files/file-io/types';

const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-wsfs-io-'));
});
afterEach(() => {
  setDefaultContentIo(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeIo(): ContentIo & { reads: string[]; writes: Array<{ p: string; size: number }> } {
  const io = {
    reads: [] as string[],
    writes: [] as Array<{ p: string; size: number }>,
    async readFile(p: string) {
      io.reads.push(p);
      return Buffer.from('via-io');
    },
    async writeFile(p: string, d: Buffer) {
      io.writes.push({ p, size: d.length });
    },
  };
  return io;
}

describe('WorkspaceFS 默认通道（direct）', () => {
  it('读明文正常、写正常（既有行为回归）', async () => {
    const ws = new WorkspaceFS(dir);
    await ws.writeFile('a.txt', 'hello');
    expect((await ws.readFile('a.txt')).toString('utf8')).toBe('hello');
  });

  it('读到密文 → EENCRYPTED（中性文案）', async () => {
    fs.writeFileSync(path.join(dir, 'Enc.java'), CIPHER_HEAD);
    const ws = new WorkspaceFS(dir);
    await expect(ws.readFile('Enc.java')).rejects.toMatchObject({ code: 'EENCRYPTED' });
    await expect(ws.readFile('Enc.java')).rejects.toThrow(MSG_DIRECT_CIPHER);
  });

  it('setDefaultContentIo 对未注入实例生效', async () => {
    const io = fakeIo();
    setDefaultContentIo(io);
    const ws = new WorkspaceFS(dir);
    expect((await ws.readFile('x.txt')).toString('utf8')).toBe('via-io');
    expect(io.reads).toHaveLength(1);
  });
});

describe('WorkspaceFS 注入通道', () => {
  it('readFile/writeFile/createFile 全走注入 io，且收到绝对路径', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    await ws.readFile('sub/a.txt');
    await ws.writeFile('sub/b.txt', 'xx');
    await ws.createFile('c.txt');
    expect(io.reads).toEqual([path.join(dir, 'sub', 'a.txt')]);
    expect(io.writes.map((w) => w.p)).toEqual([
      path.join(dir, 'sub', 'b.txt'),
      path.join(dir, 'c.txt'),
    ]);
  });

  it('沙箱校验先于 io：越界路径在触达 io 前抛错', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    await expect(ws.readFile('../../etc/passwd')).rejects.toThrow('路径越界');
    expect(io.reads).toHaveLength(0);
  });

  it('.git 保护仍生效', async () => {
    const io = fakeIo();
    const ws = new WorkspaceFS(dir, { contentIo: io });
    await expect(ws.readFile('.git/config')).rejects.toThrow('.git');
  });

  it('listDir / rename / deletePath 不经内容通道（元数据操作）', async () => {
    const io = fakeIo();
    const spyRead = vi.spyOn(io, 'readFile');
    const ws = new WorkspaceFS(dir, { contentIo: io });
    fs.writeFileSync(path.join(dir, 'f.txt'), '1');
    await ws.listDir('.');
    await ws.rename('f.txt', 'g.txt');
    await ws.deletePath('g.txt');
    expect(spyRead).not.toHaveBeenCalled();
    expect(io.writes).toHaveLength(0);
  });
});

describe('DirectContentIo', () => {
  it('strict 时密文抛 EENCRYPTED；非 strict 原样返回', async () => {
    const p = path.join(dir, 'Enc.java');
    fs.writeFileSync(p, CIPHER_HEAD);
    await expect(new DirectContentIo(true).readFile(p)).rejects.toMatchObject({
      code: 'EENCRYPTED',
    });
    expect((await new DirectContentIo(false).readFile(p)).equals(CIPHER_HEAD)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/workspace-fs-content-io.test.ts`
Expected: FAIL（content-io 模块不存在 / 构造签名不匹配）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/files/file-io/content-io.ts
//
// WorkspaceFS 内容通道实现（spec §5.3）。direct = 本地 fs + 密文硬失败；
// proxy = 委托 FileIoService（主进程直连）或 file-io-bridge（子进程）。
import fs from 'node:fs';
import path from 'node:path';
import { looksEncrypted } from './cipher-detect';
import { FileIoError, MSG_DIRECT_CIPHER, type ContentIo } from './types';

export class DirectContentIo implements ContentIo {
  constructor(private readonly strictCipherCheck: boolean) {}

  async readFile(absPath: string): Promise<Buffer> {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(absPath);
    } catch (e) {
      throw new FileIoError('EREAD', `读取失败: ${absPath} — ${(e as Error).message}`);
    }
    if (this.strictCipherCheck && looksEncrypted(buf)) {
      throw new FileIoError('EENCRYPTED', `${MSG_DIRECT_CIPHER}（${absPath}）`);
    }
    return buf;
  }

  async writeFile(absPath: string, data: Buffer): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      await fs.promises.writeFile(absPath, data);
    } catch (e) {
      throw new FileIoError('EWRITE', `写入失败: ${absPath} — ${(e as Error).message}`);
    }
  }
}

/** proxy 通道：委托给 FileIoService（主进程）或 BridgeContentIo（子进程）同构接口 */
export class ProxyContentIo implements ContentIo {
  constructor(
    private readonly io: {
      readFile(p: string): Promise<Buffer>;
      writeFile(p: string, data: Buffer): Promise<void>;
    },
  ) {}

  readFile(p: string): Promise<Buffer> {
    return this.io.readFile(p);
  }

  writeFile(p: string, data: Buffer): Promise<void> {
    return this.io.writeFile(p, data);
  }
}
```

修改 `electron/src/main/files/workspace-fs.ts`：

```typescript
// 1) import 头部新增：
import { DirectContentIo } from './file-io/content-io';
import type { ContentIo } from './file-io/types';

// 2) 模块级默认通道（主进程/子进程 boot 时设定；未设定 = direct 行为）：
let defaultContentIo: ContentIo | null = null;

/** 设置模块级默认内容通道（spec §5.3：主进程与 runtime 子进程各设一次） */
export function setDefaultContentIo(io: ContentIo | null): void {
  defaultContentIo = io;
}

// 3) 类字段 + 构造签名（原 constructor(private rootDir: string) 改为）：
export class WorkspaceFS {
  private extraRootDirs: string[] = [];
  private readonly injectedContentIo: ContentIo | null;

  constructor(rootDir: string, opts?: { contentIo?: ContentIo }) {
    this.rootDir = path.resolve(rootDir);
    this.injectedContentIo = opts?.contentIo ?? null;
  }

  /** 内容读写通道解析：注入 > 模块默认 > direct(strict) */
  private contentIo(): ContentIo {
    return this.injectedContentIo ?? defaultContentIo ?? new DirectContentIo(true);
  }

// 4) readFile 改为：
  async readFile(relativePath: string): Promise<Buffer> {
    const abs = this.assertInWorkspace(relativePath);
    return this.contentIo().readFile(abs);
  }

// 5) writeFile 改为：
  async writeFile(relativePath: string, content: string | Buffer): Promise<void> {
    const abs = this.assertInWorkspace(relativePath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await this.contentIo().writeFile(
      abs,
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'),
    );
  }

// 6) createFile 改为：
  async createFile(relativePath: string): Promise<void> {
    const abs = this.assertInWorkspace(relativePath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await this.contentIo().writeFile(abs, Buffer.alloc(0));
  }
```

- [ ] **Step 4: 运行新测试 + 既有回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/workspace-fs-content-io.test.ts`
Expected: PASS
Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/`
Expected: 全绿（既有 workspace-fs 用例不回归）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/files/file-io/content-io.ts electron/src/main/files/workspace-fs.ts electron/tests/files/workspace-fs-content-io.test.ts
git commit -m "feat(files): WorkspaceFS 内容通道收口（direct/proxy 路由 + 密文硬失败）"
```

---

## Task 6: 主进程单例与 bootstrap 接线

**Files:**
- Create: `electron/src/main/files/file-io/index.ts`
- Modify: `electron/src/main/ipc/index.ts`（registerFileHandlers 之后 `initFileIo()`）
- Test: `electron/tests/files/file-io/index.test.ts`

**Interfaces:**
- Consumes: Task 2（`resolveFileIoSettings` / `FileIoConfig`）、Task 4（`FileIoService`）、Task 5（`setDefaultContentIo` / `DirectContentIo` / `ProxyContentIo`）
- Produces: `getFileIoService(): FileIoService`；`syncFileIoDefaults(raw?: FileIoConfig): void`；`initFileIo(): void`；`__closeFileIoForTest(): void`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/files/file-io/index.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  __closeFileIoForTest,
  getFileIoService,
  syncFileIoDefaults,
} from '../../../src/main/files/file-io/index';
import { getDefaultContentIoForTest } from '../../../src/main/files/workspace-fs';
import { DirectContentIo, ProxyContentIo } from '../../../src/main/files/file-io/content-io';

afterEach(() => {
  __closeFileIoForTest();
});

describe('FileIo 单例与默认通道同步', () => {
  it('getFileIoService 返回同一实例', () => {
    expect(getFileIoService()).toBe(getFileIoService());
  });

  it('direct 设置 → 默认通道为 DirectContentIo', () => {
    syncFileIoDefaults({ mode: 'direct' });
    expect(getDefaultContentIoForTest()).toBeInstanceOf(DirectContentIo);
  });

  it('proxy 设置 → 默认通道为 ProxyContentIo（包住单例）', () => {
    syncFileIoDefaults({ mode: 'proxy' });
    expect(getDefaultContentIoForTest()).toBeInstanceOf(ProxyContentIo);
  });

  it('__closeFileIoForTest 清空单例与默认通道', () => {
    const first = getFileIoService();
    __closeFileIoForTest();
    expect(getFileIoService()).not.toBe(first);
  });
});
```

> 注：测试需要读取模块默认通道，Task 5 的 `workspace-fs.ts` 需额外导出
> `export function getDefaultContentIoForTest(): ContentIo | null { return defaultContentIo; }`
> （本 Task Step 3 一并补上）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/index.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

先在 `workspace-fs.ts` 补测试读取口（Task 5 的 `setDefaultContentIo` 旁）：

```typescript
/** 仅供测试：读取当前模块默认内容通道 */
export function getDefaultContentIoForTest(): ContentIo | null {
  return defaultContentIo;
}
```

```typescript
// electron/src/main/files/file-io/index.ts
//
// FileIo 主进程单例与 boot 接线（spec §5.8）。主进程 WorkspaceFS 的默认内容
// 通道由本模块统一同步——所有既有构造点零改动。
import { getGlobalSettings } from '../../settings/crud';
import { logger } from '../../logger';
import { loadElectronApis } from '../../electron-access';
import { setDefaultContentIo } from '../workspace-fs';
import { FileIoService } from './file-io-service';
import {
  detectClientInstalled,
  resolveFileIoSettings,
  type FileIoConfig,
} from './file-io-settings';
import { DirectContentIo, ProxyContentIo } from './content-io';

let shared: FileIoService | null = null;

export function getFileIoService(): FileIoService {
  if (shared === null) {
    shared = new FileIoService({
      settings: resolveFileIoSettings(getGlobalSettings().fileIo),
      logger,
    });
  }
  return shared;
}

/**
 * 把全局设置同步进单例 + 模块默认内容通道。raw 仅测试注入；生产从 kv_store 读。
 * 设置页保存后经 fileIo:getState / fileIo:probe 触发（Task 8）。
 */
export function syncFileIoDefaults(raw?: FileIoConfig): void {
  const svc = getFileIoService();
  const settings = resolveFileIoSettings(raw ?? getGlobalSettings().fileIo);
  svc.applySettings(settings);
  const clientInstalled = detectClientInstalled();
  setDefaultContentIo(
    svc.effectiveMode() === 'proxy'
      ? new ProxyContentIo(svc)
      : new DirectContentIo(settings.strictCipherCheck),
  );
  logger.info('File IO 通道已同步', { mode: settings.mode, effective: svc.effectiveMode() });
}

/** app bootstrap 接线（ipc/index.ts 在 registerFileHandlers 后调用） */
export function initFileIo(): void {
  syncFileIoDefaults();
  const { app } = loadElectronApis();
  if (app) {
    app.on('will-quit', () => {
      shared?.close();
      shared = null;
    });
  } else {
    logger.warn('File IO bootstrap 运行在无 Electron 环境（测试），will-quit 未挂接');
  }
}

/** 测试 teardown：关 worker + 清单例 + 复位默认通道 */
export function __closeFileIoForTest(): void {
  shared?.close();
  shared = null;
  setDefaultContentIo(null);
}
```

修改 `electron/src/main/ipc/index.ts`：

```typescript
// 1) 与 registerFileHandlers 同区新增 import：
import { initFileIo } from '../files/file-io';

// 2) registerFileHandlers() 调用之后紧邻新增：
initFileIo();
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/index.test.ts`
Expected: PASS（4 用例）
Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/files/file-io/index.ts electron/src/main/files/workspace-fs.ts electron/src/main/ipc/index.ts electron/tests/files/file-io/index.test.ts
git commit -m "feat(files): FileIo 单例与 bootstrap 接线（默认通道同步 + will-quit 回收）"
```

---

## Task 7: 子进程桥与 AGENT_CONFIG 下发

**Files:**
- Create: `electron/src/main/files/file-io/file-io-bridge.ts`（子进程侧）
- Create: `electron/src/main/files/file-io/main-bridge.ts`（主进程侧）
- Modify: `electron/src/main/agent/runtime-config.ts`（`AgentRuntimeOpts.fileIoMode` + `RuntimeConfig`/`parseConfig`）
- Modify: `electron/src/main/agent/runtime-spawner.ts`（AGENT_CONFIG 注入 + messageHandler 新分支）
- Modify: `electron/src/main/agent/runtime-entry.ts`（boot 装配子进程内容通道 + 应答分发）
- Test: `electron/tests/files/file-io/file-io-bridge.test.ts`
- Test: `electron/tests/files/file-io/main-bridge.test.ts`

**Interfaces:**
- Consumes: Task 1（`ContentIo` / `FileIoError`）、Task 4（`FileIoService`）、Task 5（`setDefaultContentIo` / `DirectContentIo` / `BridgeContentIo` 依赖的 `ContentIo`）、Task 6（`getFileIoService`）
- Produces:
  - 子进程侧：`requestFileIoRead(p): Promise<Buffer>` / `requestFileIoReadMany(paths): Promise<Buffer[]>` / `requestFileIoWrite(p, data): Promise<void>` / `handleFileIoResp(msg): void` / `class BridgeContentIo implements ContentIo`
  - 主进程侧：`handleFileIoRequestMsg(msg, respond, svc?): Promise<boolean>`
  - 线协议：child→main `{ type: 'file-io:req', requestId, op, path?, paths?, dataBase64? }`；main→child `{ type: 'file-io:resp', requestId, ok, dataBase64? | items? | error? }`

- [ ] **Step 1: 写失败测试（桥 + 主进程处理器）**

```typescript
// electron/tests/files/file-io/file-io-bridge.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeContentIo,
  handleFileIoResp,
} from '../../../src/main/files/file-io/file-io-bridge';

const origSend = process.send;
afterEach(() => {
  // 还原 process.send（测试环境本来为 undefined）
  if (origSend === undefined) delete (process as { send?: unknown }).send;
  else (process as { send?: unknown }).send = origSend;
});

describe('file-io-bridge（子进程侧）', () => {
  it('非 fork 环境立即 reject（绝不挂等）', async () => {
    await expect(new BridgeContentIo().readFile('/x')).rejects.toThrow('process.send');
  });

  it('请求经 process.send 以方法调用形式发出，应答经 handleFileIoResp 配对', async () => {
    const sent: Array<Record<string, unknown>> = [];
    (process as { send?: unknown }).send = (msg: Record<string, unknown>) => {
      sent.push(msg);
    };
    const reading = new BridgeContentIo().readFile('/abs/a.java');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'file-io:req', op: 'read', path: '/abs/a.java' });
    const requestId = String(sent[0].requestId);
    handleFileIoResp({
      type: 'file-io:resp',
      requestId,
      ok: true,
      dataBase64: Buffer.from('class A {}').toString('base64'),
    });
    expect((await reading).toString('utf8')).toBe('class A {}');
  });

  it('主进程错误载荷 → reject 且 code 保留', async () => {
    const sent: Array<Record<string, unknown>> = [];
    (process as { send?: unknown }).send = (msg: Record<string, unknown>) => sent.push(msg);
    const writing = new BridgeContentIo().writeFile('/abs/b.java', Buffer.from('x'));
    handleFileIoResp({
      type: 'file-io:resp',
      requestId: String(sent[0].requestId),
      ok: false,
      error: { code: 'EENCRYPTED', message: '密文' },
    });
    await expect(writing).rejects.toMatchObject({ code: 'EENCRYPTED' });
  });

  it('未知 requestId / 非本协议消息静默忽略', () => {
    expect(() => handleFileIoResp({ type: 'file-io:resp', requestId: 'nope', ok: true })).not.toThrow();
    expect(() => handleFileIoResp({ type: 'other' })).not.toThrow();
  });
});
```

```typescript
// electron/tests/files/file-io/main-bridge.test.ts
import { describe, expect, it } from 'vitest';
import { handleFileIoRequestMsg } from '../../../src/main/files/file-io/main-bridge';
import { FileIoError } from '../../../src/main/files/file-io/types';

function fakeSvc(overrides?: Partial<{ readFile: (p: string) => Promise<Buffer>; writeFile: (p: string, d: Buffer) => Promise<void>; readFiles: (ps: string[]) => Promise<Buffer[]> }>) {
  return {
    readFile: overrides?.readFile ?? (async () => Buffer.from('read')),
    writeFile: overrides?.writeFile ?? (async () => undefined),
    readFiles: overrides?.readFiles ?? (async (ps: string[]) => ps.map(() => Buffer.from('many'))),
  };
}

describe('handleFileIoRequestMsg（主进程侧）', () => {
  it('read → ok + dataBase64', async () => {
    const out: Array<Record<string, unknown>> = [];
    const consumed = await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'r1', op: 'read', path: '/a.java' },
      (p) => out.push(p),
      fakeSvc() as never,
    );
    expect(consumed).toBe(true);
    expect(out[0]).toMatchObject({ type: 'file-io:resp', requestId: 'r1', ok: true });
    expect(Buffer.from(String(out[0].dataBase64), 'base64').toString('utf8')).toBe('read');
  });

  it('write → ok:true；readMany → items 数组', async () => {
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'r2', op: 'write', path: '/b.java', dataBase64: 'eA==' },
      (p) => out.push(p),
      fakeSvc() as never,
    );
    expect(out[0]).toMatchObject({ requestId: 'r2', ok: true });

    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'r3', op: 'readMany', paths: ['/x', '/y'] },
      (p) => out.push(p),
      fakeSvc() as never,
    );
    expect((out[1].items as unknown[]).length).toBe(2);
  });

  it('FileIoError → error.code 原样透传', async () => {
    const out: Array<Record<string, unknown>> = [];
    await handleFileIoRequestMsg(
      { type: 'file-io:req', requestId: 'r4', op: 'read', path: '/enc.java' },
      (p) => out.push(p),
      fakeSvc({ readFile: async () => { throw new FileIoError('EENCRYPTED', '密文'); } }) as never,
    );
    expect(out[0]).toMatchObject({ ok: false, error: { code: 'EENCRYPTED' } });
  });

  it('非本协议消息返回 false（不消费）', async () => {
    expect(await handleFileIoRequestMsg({ type: 'other' }, () => {}, fakeSvc() as never)).toBe(false);
    expect(await handleFileIoRequestMsg(null, () => {}, fakeSvc() as never)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/file-io-bridge.test.ts tests/files/file-io/main-bridge.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现桥两端**

```typescript
// electron/src/main/files/file-io/file-io-bridge.ts
//
// 子进程侧文件 IO 桥（spec §5.4）——镜像 process-bridge.ts 结构。
// 线协议（两端同 commit 修改，momo-boundary-rules）：
//   child → main: { type: 'file-io:req', requestId, op: 'read'|'readMany'|'write',
//                   path?, paths?, dataBase64? }
//   main → child: { type: 'file-io:resp', requestId, ok,
//                   dataBase64? | items? | error?: { code, message } }
// 铁律：process.send 方法调用形式（2.0.0 P0-1 this 绑定教训）；非 fork 环境
// 立即 reject；超时清 pending 防泄漏。本模块禁止 import 'electron'。
import { randomUUID } from 'node:crypto';
import { FileIoError, type ContentIo, type FileIoErrorCode } from './types';

const BRIDGE_TIMEOUT_MS = 30_000;
const TIMEOUT_MESSAGE = '文件读写 IPC 无响应（主进程未接线或超时）';
const NO_SEND_MESSAGE = '文件读写 IPC 不可用（process.send 缺失：非 fork 子进程环境）';

interface FileIoRespPayload {
  ok: boolean;
  dataBase64?: string;
  items?: Array<{ ok: boolean; dataBase64?: string; error?: { code: string; message: string } }>;
  error?: { code: string; message: string };
}

interface PendingEntry {
  resolve: (r: FileIoRespPayload) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();

function toFileIoError(err: { code?: string; message?: string } | undefined): FileIoError {
  const code = (err?.code ?? 'EREAD') as FileIoErrorCode;
  return new FileIoError(code, err?.message ?? '文件读写失败');
}

function sendFileIoOp(payload: Record<string, unknown>): Promise<FileIoRespPayload> {
  return new Promise<FileIoRespPayload>((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new FileIoError('ECHILD', NO_SEND_MESSAGE));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new FileIoError('ETIMEOUT', TIMEOUT_MESSAGE));
    }, BRIDGE_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try {
      // 方法调用形式（不可解构）——真实 Node 读 this.connected
      process.send({ type: 'file-io:req', requestId, ...payload });
    } catch (err) {
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** 主进程应答分发（runtime-entry 的 taskMessageListener 调，未知消息 no-op） */
export function handleFileIoResp(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; requestId?: unknown } & FileIoRespPayload;
  if (m.type !== 'file-io:resp' || typeof m.requestId !== 'string') return;
  const entry = pending.get(m.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(m.requestId);
  if (m.ok) entry.resolve(m);
  else entry.reject(toFileIoError(m.error));
}

export async function requestFileIoRead(p: string): Promise<Buffer> {
  const r = await sendFileIoOp({ op: 'read', path: p });
  if (r.dataBase64 === undefined) throw toFileIoError(r.error);
  return Buffer.from(r.dataBase64, 'base64');
}

export async function requestFileIoReadMany(paths: string[]): Promise<Buffer[]> {
  const r = await sendFileIoOp({ op: 'readMany', paths });
  if (!r.ok || !Array.isArray(r.items) || r.items.length !== paths.length) {
    throw toFileIoError(r.error);
  }
  return r.items.map((item) => {
    if (!item.ok || item.dataBase64 === undefined) throw toFileIoError(item.error);
    return Buffer.from(item.dataBase64, 'base64');
  });
}

export async function requestFileIoWrite(p: string, data: Buffer): Promise<void> {
  const r = await sendFileIoOp({ op: 'write', path: p, dataBase64: data.toString('base64') });
  if (!r.ok) throw toFileIoError(r.error);
}

/** 子进程侧 proxy 内容通道（runtime-entry 按 AGENT_CONFIG.fileIoMode 装配） */
export class BridgeContentIo implements ContentIo {
  readFile(p: string): Promise<Buffer> {
    return requestFileIoRead(p);
  }
  writeFile(p: string, data: Buffer): Promise<void> {
    return requestFileIoWrite(p, data);
  }
}
```

```typescript
// electron/src/main/files/file-io/main-bridge.ts
//
// 主进程侧 file-io 请求处理（spec §5.4）。runtime-spawner 的 messageHandler
// 分支调用；respond 由 spawn 闭包提供（通道关闭防御在调用方）。
import { getFileIoService } from './index';
import type { FileIoService } from './file-io-service';

type Respond = (payload: Record<string, unknown>) => void;

export async function handleFileIoRequestMsg(
  msg: unknown,
  respond: Respond,
  svc: Pick<FileIoService, 'readFile' | 'writeFile' | 'readFiles'> = getFileIoService(),
): Promise<boolean> {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as {
    type?: string;
    requestId?: unknown;
    op?: unknown;
    path?: unknown;
    paths?: unknown;
    dataBase64?: unknown;
  };
  if (m.type !== 'file-io:req' || typeof m.requestId !== 'string') return false;
  const requestId = m.requestId;
  try {
    if (m.op === 'read' && typeof m.path === 'string') {
      const buf = await svc.readFile(m.path);
      respond({ type: 'file-io:resp', requestId, ok: true, dataBase64: buf.toString('base64') });
    } else if (m.op === 'write' && typeof m.path === 'string' && typeof m.dataBase64 === 'string') {
      await svc.writeFile(m.path, Buffer.from(m.dataBase64, 'base64'));
      respond({ type: 'file-io:resp', requestId, ok: true });
    } else if (m.op === 'readMany' && Array.isArray(m.paths)) {
      const bufs = await svc.readFiles(m.paths.map((p) => String(p)));
      respond({
        type: 'file-io:resp',
        requestId,
        ok: true,
        items: bufs.map((b) => ({ ok: true, dataBase64: b.toString('base64') })),
      });
    } else {
      respond({
        type: 'file-io:resp',
        requestId,
        ok: false,
        error: { code: 'EBADREQ', message: '非法 file-io 请求' },
      });
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    respond({
      type: 'file-io:resp',
      requestId,
      ok: false,
      error: {
        code: typeof e.code === 'string' ? e.code : 'EUNKNOWN',
        message: typeof e.message === 'string' ? e.message : String(err),
      },
    });
  }
  return true;
}
```

- [ ] **Step 4: 运行桥测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/files/file-io/file-io-bridge.test.ts tests/files/file-io/main-bridge.test.ts`
Expected: PASS（8 用例）

- [ ] **Step 5: 接线（runtime-config / spawner / entry）**

`electron/src/main/agent/runtime-config.ts`：

```typescript
// AgentRuntimeOpts 接口内新增（fileIoMode 为 spawn 时已解析的生效模式）：
  /** 文件访问生效模式（spec 2026-11-11 §5.6）：spawn 时定型，运行中不随设置变更 */
  fileIoMode?: 'direct' | 'proxy';
```

`electron/src/main/agent/runtime-entry.ts`（该文件有自己的 `RuntimeConfig` 接口与 `parseConfig`——按相邻字段同款追加）：

```typescript
// 1) RuntimeConfig 接口新增：
  fileIoMode: 'direct' | 'proxy';

// 2) parseConfig 返回对象新增（缺省 direct——旧版本 spawn 无此字段时安全）：
    fileIoMode: parsed.fileIoMode === 'proxy' ? 'proxy' : 'direct',

// 3) import 新增：
import { setDefaultContentIo } from '../files/workspace-fs';
import { BridgeContentIo, handleFileIoResp } from '../files/file-io/file-io-bridge';
import { DirectContentIo } from '../files/file-io/content-io';

// 4) main() 内 parseConfig 之后（bootRuntimeContext 之前）装配子进程内容通道：
  setDefaultContentIo(
    config.fileIoMode === 'proxy' ? new BridgeContentIo() : new DirectContentIo(true),
  );

// 5) taskMessageListener 中调用 handleProcessOpResult(msg) 的同一位置，紧邻追加：
  handleFileIoResp(msg);
```

`electron/src/main/agent/runtime-spawner.ts`：

```typescript
// 1) import 新增：
import { handleFileIoRequestMsg } from '../files/file-io/main-bridge';
import { detectClientInstalled, resolveEffectiveMode, resolveFileIoSettings } from '../files/file-io/file-io-settings';
import { getGlobalSettings } from '../settings/crud';

// 2) spawnForAgent 中构造 childConfig 处（sandboxProbe 合并那一行之后）追加：
  const fileIoMode = resolveEffectiveMode(
    resolveFileIoSettings(getGlobalSettings().fileIo),
    detectClientInstalled(),
  );
  // 后续 childConfig 合并对象中补 fileIoMode（与 sandboxProbe 同款对象展开）：
  const mergedConfig = { ...runtimeConfig, fileIoMode, ...(sandboxProbe ? { sandboxProbe } : {}) };
  // 注意：AGENT_CONFIG 用 mergedConfig 序列化（替换原 childConfig 变量名时保持
  // 「有 sandboxProbe 才带」的语义——直接以 mergedConfig 作为 AGENT_CONFIG 来源）。

// 3) messageHandler 分支链中 resource-op 分支之后、StreamChunk 转发之前追加：
    // 文件 IO 桥（spec 2026-11-11 §5.4）：子进程 proxy 模式读写经主进程 FileIoService
    if (m.type === 'file-io:req' && typeof m.requestId === 'string') {
      await handleFileIoRequestMsg(msg, (payload) => {
        try {
          child.send(payload);
        } catch {
          // 通道已关闭，应答无法送达——子进程侧超时兜底
        }
      });
      return;
    }
```

- [ ] **Step 6: 运行受影响的既有测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-registry.test.ts tests/agent/dispatch-snapshot.test.ts tests/agent/runtime-boot-handshake-fork.test.ts`
Expected: 全绿（AGENT_CONFIG 新增字段不破坏既有断言）
Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error

- [ ] **Step 7: 提交**

```bash
git add electron/src/main/files/file-io/file-io-bridge.ts electron/src/main/files/file-io/main-bridge.ts electron/src/main/agent/runtime-config.ts electron/src/main/agent/runtime-spawner.ts electron/src/main/agent/runtime-entry.ts electron/tests/files/file-io/file-io-bridge.test.ts electron/tests/files/file-io/main-bridge.test.ts
git commit -m "feat(agent): 子进程 file-io 桥与 AGENT_CONFIG 模式下发"
```

---

## Task 8: fileIo IPC 与设置面板

**Files:**
- Create: `electron/src/main/files/file-io/ipc.handlers.ts`
- Modify: `electron/src/main/ipc/index.ts`（注册 fileIo handlers）
- Modify: `electron/src/preload/index.ts`（`fileIo` 命名空间）
- Modify: `renderer/src/ipc/types.d.ts`（`FileIoStatus` / `FileIoApiSurface` / `ApiSurface.fileIo`）
- Modify: `renderer/src/stores/settings.store.ts`（`SettingsCategory` 增加 `'file_io'`）
- Modify: `renderer/src/components/settings/SettingsNav.tsx`（CATEGORIES 新增「文件访问」）
- Modify: `renderer/src/components/settings/SettingsView.tsx`（渲染分支）
- Create: `renderer/src/components/settings/FileIoSettingsPanel.tsx`
- Test: `renderer/src/components/settings/FileIoSettingsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 2（settings 读写链路）、Task 6（`syncFileIoDefaults` / `getFileIoService`）、Task 4（`findNodePath`）
- Produces: IPC `fileIo:getState` / `fileIo:probe` → `FileIoStatus { mode: FileIoMode; effectiveMode: 'direct'|'proxy'; clientInstalled: boolean; nodeAvailable: boolean; nodePath: string | null; nodeVersion: string | null }`

> **预览门禁（momo-ui-preview-rules，P1）**：本任务 Step 1 先出静态预览——以 spec §5.6 已获批线框为基线（三档 radio + Node.js 路径输入 + 状态卡 + 重新检测）。若实现形态与线框有实质出入，先截图给用户确认再继续；实现完成后按 P1 事后截图验收。

- [ ] **Step 1: 预览确认**

按 spec §5.6 线框核对实现形态（标题「文件访问」/ 三档 radio / 路径输入 / 状态卡 / 重新检测按钮），文案中性化。用户在线框审批时已确认该形态——如无实质出入，直接进入 Step 2。

- [ ] **Step 2: 写失败测试（renderer 面板）**

```tsx
// renderer/src/components/settings/FileIoSettingsPanel.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileIoSettingsPanel } from './FileIoSettingsPanel';

const getState = vi.fn();
const probe = vi.fn();
const updateGlobal = vi.fn();

beforeEach(() => {
  getState.mockResolvedValue({
    mode: 'direct',
    effectiveMode: 'direct',
    clientInstalled: false,
    nodeAvailable: true,
    nodePath: 'C:\\nodejs\\node.exe',
    nodeVersion: 'v14.21.3',
  });
  probe.mockResolvedValue({
    mode: 'proxy',
    effectiveMode: 'proxy',
    clientInstalled: true,
    nodeAvailable: true,
    nodePath: 'C:\\nodejs\\node.exe',
    nodeVersion: 'v14.21.3',
  });
  updateGlobal.mockResolvedValue(undefined);
  Object.assign(globalThis, {
    window: { api: { fileIo: { getState, probe }, settings: { updateGlobal } } },
  });
});

describe('FileIoSettingsPanel', () => {
  it('渲染三档模式与状态卡（中性文案）', async () => {
    render(<FileIoSettingsPanel />);
    expect(await screen.findByText('直接读写（默认）')).toBeInTheDocument();
    expect(screen.getByText('Node 代理')).toBeInTheDocument();
    expect(screen.getByText('自动检测')).toBeInTheDocument();
    expect(screen.getByText(/node\.exe/)).toBeInTheDocument();
    // 中性化：不得出现敏感字样
    expect(document.body.textContent ?? '').not.toMatch(/亿赛通|白名单|安全部门|合规/);
  });

  it('切换模式 → settings.updateGlobal 携带 fileIo 补丁', async () => {
    render(<FileIoSettingsPanel />);
    await screen.findByText('Node 代理');
    fireEvent.click(screen.getByLabelText('Node 代理'));
    await waitFor(() =>
      expect(updateGlobal).toHaveBeenCalledWith(
        expect.objectContaining({ fileIo: expect.objectContaining({ mode: 'proxy' }) }),
      ),
    );
  });

  it('重新检测 → 调 fileIo.probe', async () => {
    render(<FileIoSettingsPanel />);
    await screen.findByText('重新检测');
    fireEvent.click(screen.getByText('重新检测'));
    await waitFor(() => expect(probe).toHaveBeenCalled());
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/FileIoSettingsPanel.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 4: 实现主进程 IPC + preload + 类型**

```typescript
// electron/src/main/files/file-io/ipc.handlers.ts
//
// fileIo:* IPC（spec §5.6 设置面板数据面）。buildFileIoStatus 可注入 raw 供单测。
import { ipcMain } from 'electron';
import { spawnSync } from 'node:child_process';
import { logger } from '../../logger';
import { getGlobalSettings } from '../../settings/crud';
import {
  detectClientInstalled,
  resolveEffectiveMode,
  resolveFileIoSettings,
  type FileIoConfig,
} from './file-io-settings';
import { findNodePath } from './file-io-service';
import { syncFileIoDefaults } from './index';
import type { EffectiveFileIoMode, FileIoMode } from './types';

export interface FileIoStatus {
  mode: FileIoMode;
  effectiveMode: EffectiveFileIoMode;
  clientInstalled: boolean;
  nodeAvailable: boolean;
  nodePath: string | null;
  nodeVersion: string | null;
}

/** 聚合状态（设置面板状态卡数据源）；raw 仅测试注入 */
export function buildFileIoStatus(raw?: FileIoConfig): FileIoStatus {
  const settings = resolveFileIoSettings(raw ?? getGlobalSettings().fileIo);
  const clientInstalled = detectClientInstalled();
  let nodePath: string | null = null;
  let nodeVersion: string | null = null;
  try {
    nodePath = findNodePath(settings.nodePath);
    const r = spawnSync(nodePath, ['-v'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    nodeVersion = r.status === 0 ? String(r.stdout).trim() : null;
  } catch {
    // ENONODE：nodePath 保持 null（面板显示「未找到」）
  }
  return {
    mode: settings.mode,
    effectiveMode: resolveEffectiveMode(settings, clientInstalled),
    clientInstalled,
    nodeAvailable: nodePath !== null,
    nodePath,
    nodeVersion,
  };
}

export function registerFileIoHandlers(): void {
  ipcMain.handle('fileIo:getState', () => {
    syncFileIoDefaults();
    return buildFileIoStatus();
  });
  ipcMain.handle('fileIo:probe', () => {
    syncFileIoDefaults();
    return buildFileIoStatus();
  });
  logger.info('File IO IPC handlers 已注册');
}
```

`electron/src/main/ipc/index.ts`：在 `initFileIo()` 之后追加 `registerFileIoHandlers();`（import 同区新增）。

`electron/src/preload/index.ts`（按相邻命名空间同款写法——先 Read 该文件确认风格后追加）：

```typescript
// api 对象内新增（与 sandbox 等命名空间并列）：
  fileIo: {
    getState: () => ipcRenderer.invoke('fileIo:getState'),
    probe: () => ipcRenderer.invoke('fileIo:probe'),
  },
```

`renderer/src/ipc/types.d.ts`（与 `SandboxApiSurface` 同文件）：

```typescript
/** 文件访问模式（与 electron 端 file-io/types.ts 对齐） */
export type FileIoMode = 'direct' | 'proxy' | 'auto';

/** fileIo:getState / fileIo:probe 返回（与 electron 端 FileIoStatus 对齐） */
export interface FileIoStatus {
  mode: FileIoMode;
  effectiveMode: 'direct' | 'proxy';
  clientInstalled: boolean;
  nodeAvailable: boolean;
  nodePath: string | null;
  nodeVersion: string | null;
}

export interface FileIoApiSurface {
  getState(): Promise<FileIoStatus>;
  probe(): Promise<FileIoStatus>;
}

// ApiSurface 接口内（sandbox 成员附近）新增：
  fileIo: FileIoApiSurface;
```

同时找到 renderer 侧 `GlobalSettings` 镜像（`ipc.settings.updateGlobal` 入参类型所在，grep `sandboxMode` 定位），追加：

```typescript
  fileIo?: { mode?: FileIoMode; nodePath?: string; strictCipherCheck?: boolean };
```

- [ ] **Step 5: 实现面板与导航**

```tsx
// renderer/src/components/settings/FileIoSettingsPanel.tsx
//
// 文件访问设置（spec §5.6）。形态同构 SandboxSettingsPanel（三档 radio +
// 状态卡 + 重新检测）。文案中性化：不出现具体加密产品/白名单/合规字样。
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ipc } from '../../ipc/client';
import type { FileIoMode, FileIoStatus } from '../../ipc/types';

const MODE_OPTIONS: readonly { value: FileIoMode; label: string; hint: string }[] = [
  { value: 'direct', label: '直接读写（默认）', hint: '应用直接读写本地文件' },
  { value: 'proxy', label: 'Node 代理', hint: '通过 node 代理进程读写文件' },
  { value: 'auto', label: '自动检测', hint: '检测到需要代理的环境时自动启用' },
];

export function FileIoSettingsPanel(): React.ReactElement {
  const [status, setStatus] = useState<FileIoStatus | null>(null);
  const [nodePath, setNodePath] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void ipc.fileIo.getState().then((s) => {
      setStatus(s);
      setNodePath(s.nodePath ?? '');
    });
  }, []);

  const save = (mode: FileIoMode): void => {
    if (!status) return;
    setStatus({ ...status, mode });
    // 乐观 UI：保存 fire-and-forget，随后 probe 刷新最终态（与沙箱面板弱一致）
    void ipc.settings
      .updateGlobal({ fileIo: { mode, nodePath: nodePath.trim() || undefined } })
      .catch(() => {});
    void ipc.fileIo.probe().then(setStatus).catch(() => {});
  };

  const reprobe = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await ipc.fileIo.probe());
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="p-4 text-sm text-secondary">加载中...</div>;

  return (
    <section className="flex flex-col gap-6" aria-label="文件访问设置">
      <div>
        <h2 className="mb-1 text-base text-primary">文件访问</h2>
        <p className="text-sm text-secondary">选择应用读写本地文件的方式。</p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">文件访问模式</legend>
        {MODE_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="radio"
              name="file-io-mode"
              checked={status.mode === o.value}
              onChange={() => save(o.value)}
              className="mt-1"
              aria-label={o.label}
            />
            <span>
              {o.label}——{o.hint}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1">
        <Input
          label="Node.js 路径（可选）"
          className="w-full font-mono text-[12.5px]"
          value={nodePath}
          onChange={(e) => setNodePath(e.target.value)}
          onBlur={() => {
            if (!status) return;
            void ipc.settings
              .updateGlobal({ fileIo: { mode: status.mode, nodePath: nodePath.trim() || undefined } })
              .catch(() => {});
            void ipc.fileIo.probe().then(setStatus).catch(() => {});
          }}
          placeholder="留空 = 自动查找系统 Node.js"
        />
      </div>

      <div className="rounded-lg border border-subtle bg-surface-2 p-3 flex flex-col gap-2">
        <div className="text-sm">
          <span className="text-tertiary">代理环境：</span>
          <span className="font-mono text-xs text-secondary">
            {status.clientInstalled ? '已检测到' : '未检测到'}
          </span>
        </div>
        <div className="text-sm">
          <span className="text-tertiary">node.exe：</span>
          <span className="font-mono text-xs text-secondary">
            {status.nodeAvailable ? `可用${status.nodeVersion ? ` (${status.nodeVersion})` : ''}` : '未找到'}
          </span>
        </div>
        <div className="text-sm">
          <span className="text-tertiary">生效模式：</span>
          <span className="font-mono text-xs text-secondary">
            {status.effectiveMode === 'proxy' ? 'Node 代理' : '直接读写'}
          </span>
        </div>
        <Button onClick={() => void reprobe()} disabled={busy}>
          {busy ? '检测中...' : '重新检测'}
        </Button>
      </div>
    </section>
  );
}
```

`renderer/src/stores/settings.store.ts`：`SettingsCategory` union 增加 `| 'file_io'`。

`renderer/src/components/settings/SettingsNav.tsx`：

```typescript
// import 行追加 HardDrive：
import { Building2, Target, MessageSquare, Puzzle, Brain, SunMoon, ShieldCheck, AppWindow, Network, ScrollText, Info, HardDrive } from 'lucide-react';

// CATEGORIES 中 sandbox 条目之后插入：
  { key: 'file_io', label: '文件访问', icon: HardDrive },
```

`renderer/src/components/settings/SettingsView.tsx`：

```tsx
// import 追加：
import { FileIoSettingsPanel } from './FileIoSettingsPanel';

// 渲染分支（sandbox 之后）追加：
          {active === 'file_io' && <FileIoSettingsPanel />}
```

- [ ] **Step 6: 运行测试 + 类型检查**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/FileIoSettingsPanel.test.tsx`
Expected: PASS（3 用例）
Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/SettingsView.test.tsx`
Expected: PASS（既有设置页测试不回归）
Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error（两 workspace——preload 类型穿透）

- [ ] **Step 7: 提交**

```bash
git add electron/src/main/files/file-io/ipc.handlers.ts electron/src/main/ipc/index.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts renderer/src/stores/settings.store.ts renderer/src/components/settings/SettingsNav.tsx renderer/src/components/settings/SettingsView.tsx renderer/src/components/settings/FileIoSettingsPanel.tsx renderer/src/components/settings/FileIoSettingsPanel.test.tsx
git commit -m "feat(settings): 文件访问设置面板与 fileIo IPC"
```

---

## Task 9: 环境冒烟脚本

**Files:**
- Create: `scripts/esafenet-probe.mjs`

**Interfaces:**
- Consumes: 无（独立 node 脚本，复刻魔数判定）
- Produces: CLI：
  - `node scripts/esafenet-probe.mjs --self-test`（离线自检）
  - `node scripts/esafenet-probe.mjs --file <路径>`（判明文/密文）
  - `node scripts/esafenet-probe.mjs --write-probe-dir <目录>`（写入探针：node 侧写 → 非白名单进程（powershell）读原始字节 → node 读回，三段比对）

- [ ] **Step 1: 实现脚本**

```javascript
#!/usr/bin/env node
// scripts/esafenet-probe.mjs
//
// 加密环境冒烟自检（spec §7.3 环境变更清单固化）。职责：
//   1. --self-test       : 无环境依赖的离线自检（魔数判定正确性）
//   2. --file <path>     : 判定目标文件读到的内容是明文还是密文
//   3. --write-probe-dir : 写入探针三段验证（写入 → 非白名单视角读盘字节 → node 侧读回）
//
// 用法示例（研发机）：
//   node scripts/esafenet-probe.mjs --self-test
//   node scripts/esafenet-probe.mjs --file "C:\\repo\\x\\A.java"
//   node scripts/esafenet-probe.mjs --write-probe-dir "C:\\repo\\x"
//
// 判读：--file 输出「密文」= 当前进程不在放行名单（正常——node 一般应为明文）；
//       若 node 也读密文，说明策略/签名校验已变更，Node 代理模式将失效。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const MAGIC = Buffer.from('E-SafeNet', 'latin1');

function looksEncrypted(buf) {
  return Boolean(buf) && buf.length >= 12 && buf.subarray(0, 64).indexOf(MAGIC) !== -1;
}

function selfTest() {
  const cipher = Buffer.from('62142365DA00260100000001452D536166654E65740000004C4F434B', 'hex');
  if (!looksEncrypted(cipher)) throw new Error('self-test 失败：密文样本未命中');
  if (looksEncrypted(Buffer.from('package com.x;\n', 'utf8'))) throw new Error('self-test 失败：明文误报');
  if (looksEncrypted(Buffer.alloc(5))) throw new Error('self-test 失败：过短缓冲应返回 false');
  console.log('[ok] self-test 通过');
}

function probeFile(p) {
  if (!fs.existsSync(p)) throw new Error(`文件不存在: ${p}`);
  const buf = fs.readFileSync(p);
  const verdict = looksEncrypted(buf) ? '密文' : '明文';
  console.log(`[${verdict}] ${p}（${buf.length} 字节）`);
  if (verdict === '密文') {
    console.log('  提示：本进程不在放行名单内。Node 代理模式依赖 node 是放行进程——');
    console.log('        若本脚本以 node 运行仍读到密文，代理模式将不可用（策略或签名校验已变更）。');
  } else {
    const head = buf.subarray(0, 80).toString('utf8').split('\n')[0];
    console.log(`  首行预览: ${JSON.stringify(head)}`);
  }
  return verdict;
}

/** 用非白名单进程视角读取磁盘原始字节（Windows 用 PowerShell；其它平台直接读盘） */
function readRawViaUnlistedProcess(p) {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${p.replace(/'/g, "''")}'))`],
      { encoding: 'utf8', timeout: 20000 },
    );
    return Buffer.from(out.trim(), 'base64');
  }
  return fs.readFileSync(p);
}

function writeProbe(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const probePath = path.join(dir, `.momo-esafenet-probe-${process.pid}.java`);
  const payload = `public class MomoProbe { /* ${new Date().toISOString()} */ }\n`;
  fs.writeFileSync(probePath, payload);

  const backViaNode = fs.readFileSync(probePath, 'utf8');
  const nodeRoundtripOk = backViaNode === payload;

  let rawCipher;
  try {
    rawCipher = looksEncrypted(readRawViaUnlistedProcess(probePath));
  } catch (e) {
    console.warn(`[warn] 非放行进程视角读取失败（${e.message}）——跳过该段检查`);
    rawCipher = null;
  }

  console.log(`[write-probe] 探针文件: ${probePath}`);
  console.log(`  node 侧写→读一致: ${nodeRoundtripOk ? 'PASS' : 'FAIL'}`);
  if (rawCipher === null) {
    console.log('  非放行进程视角: SKIP（无法读取——请人工用 IDE 打开探针文件确认）');
  } else {
    console.log(`  磁盘原始字节为密文形态: ${rawCipher ? 'PASS' : 'FAIL'}`);
    if (!rawCipher) {
      console.log('  ⚠ 落盘为明文——当前环境可能未启用代理写入要求，或写入走了非放行进程。');
    }
  }

  fs.rmSync(probePath, { force: true });
  console.log('  已清理探针文件');
  return nodeRoundtripOk && rawCipher !== false;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    return;
  }
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0 && args[fileIdx + 1]) {
    probeFile(args[fileIdx + 1]);
    return;
  }
  const dirIdx = args.indexOf('--write-probe-dir');
  if (dirIdx >= 0 && args[dirIdx + 1]) {
    const ok = writeProbe(args[dirIdx + 1]);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  console.log('用法:');
  console.log('  node scripts/esafenet-probe.mjs --self-test');
  console.log('  node scripts/esafenet-probe.mjs --file <受控文件路径>');
  console.log('  node scripts/esafenet-probe.mjs --write-probe-dir <受控目录>');
}

main();
```

- [ ] **Step 2: 验证脚本**

Run: `node scripts/esafenet-probe.mjs --self-test`
Expected: `[ok] self-test 通过`（exit 0）
Run: `node scripts/esafenet-probe.mjs --write-probe-dir /tmp`（容器/Linux 环境下非放行进程视角退化为直读）
Expected: `node 侧写→读一致: PASS`；`磁盘原始字节为密文形态: FAIL`（未装加密环境属预期）

- [ ] **Step 3: 提交**

```bash
git add scripts/esafenet-probe.mjs
git commit -m "feat(scripts): 加密环境冒烟自检脚本（读判定 + 写入探针）"
```

---

## 验收出口对照（spec §7）

| Spec 验收项 | 覆盖任务 |
|---|---|
| §7.1 单元测试（含 error path / PATH 回归锁 / 批量 / 自愈） | Task 1-8 全部测试 |
| §7.2 容器 direct 全绿 + 默认不 spawn worker | Task 4/5/6 测试 + `npx pnpm@9.0.0 test` |
| §7.3 研发机实测（读明文 / 写入探针 / 批量 / 无泄漏 / 退出回收） | Task 9 脚本 + 人工清单（spec §7.3） |
| §5.6 设置 UI（中性文案 + 预览门禁） | Task 8 |
| §5.4 子进程桥（read/readMany/write + 错误码透传） | Task 7 |
