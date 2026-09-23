// electron/tests/mcp/bundle-import.test.ts
//
// P2.1 Task 5：DXT / MCPB 本地包导入测试（parseMcpBundle / importMcpBundle /
// uninstallMcpBundle / isBundleInstalled / resolveBundleCommand）。
//
// manifest 字段树以 Task 0 核实文档（.superpowers/sdd/p21-task-0-verify.md）为准：
//   - server 是单对象（不存在 mcp_servers[] 数组），执行配置取 server.mcp_config
//   - manifest_version 判别 MCPB；dxt_version 判别 DXT；两者都无 → 拒绝
//   - server.type 白名单 node / python / binary；uv 拒绝
//   - 变量替换表：${__dirname} / ${HOME} / ${DESKTOP} / ${DOCUMENTS} / ${DOWNLOADS} /
//     ${pathSeparator} / ${/} / ${user_config.KEY}；未识别 ${...} 原样保留
//   - user_config：非 string 且 required → 拒；schema 只收必填文本（全非必填 → 空对象）
//
// 覆盖（brief Step 1 + task 指令 MUST DO 全量）：
//   - MCPB（manifest_version + server.mcp_config）判别 + 注册含 cwd
//   - DXT（dxt_version）判别
//   - manifest 缺失拒 / 双判别字段缺失拒 / server.mcp_config 缺失拒
//   - server.type=uv 拒
//   - command 白名单拒（不落目录不落库）
//   - binary 相对路径 join（含绝对化断言）+ win32 补 .exe（resolveBundleCommand 直测）
//   - `..` 逃逸拒
//   - args 滤含 `"` 项
//   - 变量替换（${__dirname} 绝对路径 + ${user_config.key} + ${HOME}/${/} + 未识别保留 + 缺省可选键空串）
//   - slug 冲突后缀 -2 / 幂等重导（同包重导覆盖目录单行记账）/ 非法名回退文件基名
//   - parse 两阶段形状（含不落正式目录）
//   - 非 string required 配置拒 / 全非必填空 schema / 无 user_config 空 schema
//   - 必填配置缺失拒（import 防线）
//   - 非 zip 拒 / 条目名绝对路径与 `..` 拒 / 条目数超限 / 解压总大小超限
//   - 卸载清目录（双表行 + cache_path 目录）+ 幂等
//
// 隔离策略沿用仓库既定模式（照抄 tests/resource/hub-install.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录 → 解包落 <tmpRoot>/mcp-bundles/
//   - runMigrations() 经 getDb() 单例建表（真实跑全量迁移）
//   - closeDb() 在 afterEach 复位单例
// zip 构造全部用真实 AdmZip（momo-test-rules 铁律 5：只隔离进程/DB 边界，业务真实）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  parseMcpBundle,
  importMcpBundle,
  uninstallMcpBundle,
  isBundleInstalled,
  resolveBundleCommand,
} from '../../src/main/mcp/bundle-import';
import { getMcpConfig } from '../../src/main/mcp/host-manager';

let tmpRoot: string;
let bundlesRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-bundle-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  bundlesRoot = path.join(tmpRoot, 'mcp-bundles');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** MCPB 官方 MANIFEST.md 实证形状（Task 0 核实文档 §2 字段树） */
const MCPB_MANIFEST = {
  manifest_version: '0.3',
  name: 'demo-bundle',
  version: '1.2.0',
  description: '演示 MCPB 包',
  display_name: 'Demo Bundle',
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js'],
      env: { API_KEY: '${user_config.api_key}' },
    },
  },
  user_config: {
    api_key: { type: 'string', title: 'API Key', required: true, sensitive: true },
  },
};

/** 构造 DXT/MCPB 包 zip Buffer：根 manifest.json + server/index.js + 可选附加文件 */
function makeBundle(manifest: unknown, extraFiles: Record<string, string> = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf-8'));
  zip.addFile('server/index.js', Buffer.from('console.log("server");\n', 'utf-8'));
  for (const [name, content] of Object.entries(extraFiles)) {
    zip.addFile(name, Buffer.from(content, 'utf-8'));
  }
  return zip.toBuffer();
}

/**
 * 构造带原始（未清洗）条目名的 zip Buffer。adm-zip 的 addFile 会经 zipnamefix
 * 清洗（'../evil' → 'evil'、'/abs' → 'abs'），故先 addFile 占位再改写 ZipEntry
 * 的 entryName（setter 不清洗）——用于回归恶意条目名防御。
 */
function makeRawEntryBundle(entryName: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(MCPB_MANIFEST), 'utf-8'));
  zip.addFile('placeholder.txt', Buffer.from('evil', 'utf-8'));
  const placeholder = zip.getEntries().find((e) => e.entryName === 'placeholder.txt');
  placeholder!.entryName = entryName;
  return zip.toBuffer();
}

// ────────────────────────────────────────────────────────────────────────────
// parseMcpBundle（两阶段第一阶段：解包预览，不落正式目录）
// ────────────────────────────────────────────────────────────────────────────

describe('parseMcpBundle（两阶段形状）', () => {
  it('MCPB（manifest_version）判别：返回完整 BundlePreview 形状（含 tempId）', () => {
    const preview = parseMcpBundle(makeBundle(MCPB_MANIFEST), 'demo-bundle.mcpb');

    expect(preview).toEqual({
      name: 'demo-bundle',
      displayName: 'Demo Bundle',
      version: '1.2.0',
      description: '演示 MCPB 包',
      serverType: 'node',
      // commandPreview 保留原始变量占位（Task 6 展示启动结构，替换发生在 import）
      commandPreview: 'node ${__dirname}/server/index.js',
      userConfigSchema: {
        api_key: { type: 'string', title: 'API Key', required: true, sensitive: true },
      },
      tempId: expect.any(String) as string,
    });
    expect(preview.tempId.length).toBeGreaterThan(0);
  });

  it('parse 不落正式目录（mcp-bundles 不被创建）', () => {
    parseMcpBundle(makeBundle(MCPB_MANIFEST), 'demo-bundle.mcpb');
    expect(fs.existsSync(bundlesRoot)).toBe(false);
  });

  it('DXT（dxt_version）判别：同构解析路径，形状一致', () => {
    const dxtManifest = {
      ...MCPB_MANIFEST,
      dxt_version: '0.1',
      manifest_version: undefined,
      name: 'dxt-ext',
      display_name: 'DXT Ext',
    };
    const preview = parseMcpBundle(makeBundle(dxtManifest), 'dxt-ext.dxt');
    expect(preview.name).toBe('dxt-ext');
    expect(preview.displayName).toBe('DXT Ext');
    expect(preview.serverType).toBe('node');
    expect(preview.userConfigSchema.api_key).toMatchObject({ type: 'string', required: true });
  });

  it('display_name 缺省回退 name', () => {
    const manifest = { ...MCPB_MANIFEST, display_name: undefined };
    const preview = parseMcpBundle(makeBundle(manifest), 'demo-bundle.mcpb');
    expect(preview.displayName).toBe('demo-bundle');
  });

  it('全非必填 user_config → userConfigSchema 空对象（Task 6 跳表单直导）', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      user_config: {
        region: { type: 'string', required: false },
        port: { type: 'number', required: false },
      },
    };
    const preview = parseMcpBundle(makeBundle(manifest), 'demo.mcpb');
    expect(preview.userConfigSchema).toEqual({});
  });

  it('无 user_config → userConfigSchema 空对象', () => {
    const manifest = { ...MCPB_MANIFEST, user_config: undefined };
    const preview = parseMcpBundle(makeBundle(manifest), 'demo.mcpb');
    expect(preview.userConfigSchema).toEqual({});
  });

  it('非 string 且 required 的配置 → 拒绝导入（暂只支持文本型）', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      user_config: { port: { type: 'number', required: true } },
    };
    expect(() => parseMcpBundle(makeBundle(manifest), 'demo.mcpb')).toThrow(
      /该包需要 number 型配置，暂只支持文本型/,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// manifest 判别与结构校验（错误路径专项）
// ────────────────────────────────────────────────────────────────────────────

describe('manifest 校验错误路径', () => {
  it('manifest.json 缺失 → 拒绝', () => {
    const zip = new AdmZip();
    zip.addFile('server/index.js', Buffer.from('console.log(1);\n', 'utf-8'));
    expect(() => parseMcpBundle(zip.toBuffer(), 'no-manifest.mcpb')).toThrow(/manifest\.json/);
  });

  it('双判别字段缺失（manifest_version 与 dxt_version 都无）→ 拒绝', () => {
    const manifest = { name: 'x', server: MCPB_MANIFEST.server };
    expect(() => parseMcpBundle(makeBundle(manifest), 'x.mcpb')).toThrow(
      /manifest_version.*dxt_version|判别/,
    );
  });

  it('server 对象 / server.mcp_config 缺失 → 拒绝（不存在 mcp_servers 数组回退）', () => {
    const noServer = { manifest_version: '0.3', name: 'x' };
    expect(() => parseMcpBundle(makeBundle(noServer), 'x.mcpb')).toThrow(/server/);

    const noConfig = {
      manifest_version: '0.3',
      name: 'x',
      server: { type: 'node', entry_point: 'a.js' },
    };
    expect(() => parseMcpBundle(makeBundle(noConfig), 'x.mcpb')).toThrow(/mcp_config/);
  });

  it('server.type=uv → 拒绝（host 装依赖语义 P3）', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      server: { ...MCPB_MANIFEST.server, type: 'uv' },
    };
    expect(() => parseMcpBundle(makeBundle(manifest), 'x.mcpb')).toThrow(
      /uv 型扩展暂不支持/,
    );
  });

  it('server.type 未知值 → 拒绝', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      server: { ...MCPB_MANIFEST.server, type: 'deno' },
    };
    expect(() => parseMcpBundle(makeBundle(manifest), 'x.mcpb')).toThrow(/server\.type/);
  });

  it('mcp_config.command 缺失 → 拒绝', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      server: { type: 'node', mcp_config: { args: ['x'] } },
    };
    expect(() => parseMcpBundle(makeBundle(manifest), 'x.mcpb')).toThrow(/command/);
  });

  it('manifest.json 非 JSON → 拒绝', () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('not-json{', 'utf-8'));
    expect(() => parseMcpBundle(zip.toBuffer(), 'x.mcpb')).toThrow(/JSON/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// importMcpBundle（解包 → 变量替换 → S1 校验 → 注册 + 记账）
// ────────────────────────────────────────────────────────────────────────────

describe('importMcpBundle 注册链', () => {
  it('MCPB 导入：解包落 mcp-bundles/{slug} + cwd 注册 + ${__dirname}/${user_config} 替换 + 记账 + 返回 ResourceItem', () => {
    const item = importMcpBundle(
      makeBundle(MCPB_MANIFEST),
      'demo-bundle.mcpb',
      { api_key: 'sk-123' },
    );

    const bundleDir = path.join(bundlesRoot, 'demo-bundle');
    // 文件真实解包落地
    expect(fs.existsSync(path.join(bundleDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'server', 'index.js'))).toBe(true);

    // 注册形态（契约测试：真实 DB 生产 → getMcpConfig 直接消费）
    const cfg = getMcpConfig('demo-bundle');
    expect(cfg).not.toBeNull();
    expect(cfg!.transport).toBe('stdio');
    expect(cfg!.command).toBe('node');
    // ${__dirname} 替换为解包目录绝对路径（含后续相对段拼接）
    expect(cfg!.args).toEqual([`${bundleDir}${path.sep}server${path.sep}index.js`]);
    // ${user_config.api_key} 替换为用户提交值
    expect(cfg!.env).toEqual({ API_KEY: 'sk-123' });
    // cwd 注册（Task 2 已接线 spawn 透传）
    expect(cfg!.cwd).toBe(bundleDir);
    expect(cfg!.source).toBe('custom');

    // 记账：item_id = bundle:{slug}，cache_path = 解包目录
    const pkg = getDb()
      .prepare('SELECT item_id, item_type, slug, cache_path FROM installed_packages')
      .get() as { item_id: string; item_type: string; slug: string; cache_path: string };
    expect(pkg).toEqual({
      item_id: 'bundle:demo-bundle',
      item_type: 'mcp',
      slug: 'demo-bundle',
      cache_path: bundleDir,
    });

    // 返回 custom ResourceItem（display_name 作 name）
    expect(item).toMatchObject({
      id: 'custom-mcp-demo-bundle',
      type: 'mcp',
      source: 'custom',
      slug: 'demo-bundle',
      name: 'Demo Bundle',
      version: '1.2.0',
      description: '演示 MCPB 包',
      installed: true,
      installable: false,
      removable: true,
    });
    expect(item.custom?.mcpConfig).toMatchObject({
      command: 'node',
      args: [`${bundleDir}${path.sep}server${path.sep}index.js`],
      env: { API_KEY: 'sk-123' },
    });
  });

  it('变量替换表：${HOME}/${DESKTOP}/${DOCUMENTS}/${DOWNLOADS}/${pathSeparator}/${/} 对应真实目录，未识别占位符原样保留', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      server: {
        type: 'node',
        mcp_config: {
          command: 'node',
          args: [],
          env: {
            HOME_REF: '${HOME}',
            DESKTOP_REF: '${DESKTOP}',
            DOCUMENTS_REF: '${DOCUMENTS}',
            DOWNLOADS_REF: '${DOWNLOADS}',
            SEP_A: '${pathSeparator}',
            SEP_B: '${/}',
            WEIRD: '${NOT_A_KNOWN_VAR}',
          },
        },
      },
    };
    importMcpBundle(makeBundle(manifest), 'demo-bundle.mcpb', { api_key: 'k' });

    const cfg = getMcpConfig('demo-bundle');
    const home = os.homedir();
    expect(cfg!.env).toEqual({
      HOME_REF: home,
      DESKTOP_REF: path.join(home, 'Desktop'),
      DOCUMENTS_REF: path.join(home, 'Documents'),
      DOWNLOADS_REF: path.join(home, 'Downloads'),
      SEP_A: path.sep,
      SEP_B: path.sep,
      // 未识别变量原样保留（warn 日志，不阻断导入）
      WEIRD: '${NOT_A_KNOWN_VAR}',
    });
  });

  it('可选 string 配置未提交 → ${user_config.key} 替换为空串', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      user_config: {
        api_key: { type: 'string', required: true },
        region: { type: 'string', required: false },
      },
      server: {
        type: 'node',
        mcp_config: {
          command: 'node',
          args: [],
          env: { REGION: '${user_config.region}' },
        },
      },
    };
    importMcpBundle(makeBundle(manifest), 'demo-bundle.mcpb', { api_key: 'k' });
    expect(getMcpConfig('demo-bundle')!.env).toEqual({ REGION: '' });
  });

  it('必填配置缺失（import 防线）→ 拒绝且不落库不落目录', () => {
    expect(() => importMcpBundle(makeBundle(MCPB_MANIFEST), 'demo-bundle.mcpb', {})).toThrow(
      /缺少必填配置/,
    );
    expect(getMcpConfig('demo-bundle')).toBeNull();
    expect(fs.existsSync(bundlesRoot)).toBe(false);
  });

  it('command 白名单外裸命令 → 拒绝且不落库不落目录', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      user_config: undefined,
      server: { type: 'node', mcp_config: { command: 'bash', args: ['-c', 'x'] } },
    };
    expect(() => importMcpBundle(makeBundle(manifest), 'demo-bundle.mcpb', {})).toThrow(
      /不支持的启动命令/,
    );
    expect(getMcpConfig('demo-bundle')).toBeNull();
    // S1 拒绝发生在 rename 之前——正式目录不留孤儿
    expect(fs.existsSync(bundlesRoot)).toBe(false);
  });

  it('args 滤含双引号项（注入防线）', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      server: {
        type: 'node',
        mcp_config: {
          command: 'node',
          args: ['--safe', 'ba"d', '--also-safe'],
          env: {},
        },
      },
    };
    importMcpBundle(makeBundle(manifest), 'demo-bundle.mcpb', { api_key: 'k' });
    expect(getMcpConfig('demo-bundle')!.args).toEqual(['--safe', '--also-safe']);
  });

  it('binary 相对路径 command → path.join(bundleDir) 绝对化注册', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      server: {
        type: 'binary',
        mcp_config: { command: './bin/tool', args: [], env: {} },
      },
    };
    importMcpBundle(makeBundle(manifest, { 'bin/tool': '#!/bin/sh\n' }), 'demo-bundle.mcpb', {
      api_key: 'k',
    });
    const bundleDir = path.join(bundlesRoot, 'demo-bundle');
    expect(getMcpConfig('demo-bundle')!.command).toBe(path.join(bundleDir, 'bin', 'tool'));
    expect(getMcpConfig('demo-bundle')!.cwd).toBe(bundleDir);
  });

  it('`..` 逃逸 command → 拒绝', () => {
    const manifest = {
      ...MCPB_MANIFEST,
      user_config: undefined,
      server: {
        type: 'binary',
        mcp_config: { command: '../evil-tool', args: [], env: {} },
      },
    };
    expect(() => importMcpBundle(makeBundle(manifest), 'demo-bundle.mcpb', {})).toThrow(
      /逃逸|越出/,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// resolveBundleCommand（win32 补 .exe 直测——linux 容器覆盖平台分支）
// ────────────────────────────────────────────────────────────────────────────

describe('resolveBundleCommand', () => {
  const bundleDir = path.join(os.tmpdir(), 'bundles', 'x');

  it('白名单裸命令原样返回', () => {
    for (const cmd of ['npx', 'node', 'npm', 'uvx', 'uv', 'python', 'python3']) {
      expect(resolveBundleCommand(cmd, bundleDir)).toBe(cmd);
    }
  });

  it('win32 平台：包内相对路径 join 后补 .exe（大小写不敏感判断后缀）', () => {
    expect(resolveBundleCommand('./bin/tool', bundleDir, 'win32')).toBe(
      path.join(bundleDir, 'bin', 'tool') + '.exe',
    );
    expect(resolveBundleCommand('bin/TOOL.EXE', bundleDir, 'win32')).toBe(
      path.join(bundleDir, 'bin', 'TOOL.EXE'),
    );
  });

  it('非 win32 平台：不补 .exe', () => {
    expect(resolveBundleCommand('./bin/tool', bundleDir, 'linux')).toBe(
      path.join(bundleDir, 'bin', 'tool'),
    );
  });

  it('绝对路径 command（${__dirname} 替换产物）指向包内 → 原样保留', () => {
    const abs = path.join(bundleDir, 'bin', 'tool');
    expect(resolveBundleCommand(abs, bundleDir, 'linux')).toBe(abs);
  });

  it('绝对路径 command 指向包外 → 拒绝', () => {
    expect(() => resolveBundleCommand('/usr/bin/env', bundleDir, 'linux')).toThrow(
      /逃逸|越出/,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// slug 规则（冲突后缀 / 文件基名回退 / 双双失败）
// ────────────────────────────────────────────────────────────────────────────

describe('slug 规则', () => {
  it('manifest.name 非法 → 回退文件基名（小写化 + 非法字符转 -）', () => {
    const manifest = { ...MCPB_MANIFEST, name: 'Demo Bundle!' };
    const item = importMcpBundle(makeBundle(manifest), 'My Bundle.mcpb', { api_key: 'k' });
    expect(item.slug).toBe('my-bundle');
    expect(getMcpConfig('my-bundle')).not.toBeNull();
    expect(item.id).toBe('custom-mcp-my-bundle');
  });

  it('manifest.name 与文件基名均无法产出合法 slug → 拒绝', () => {
    const manifest = { ...MCPB_MANIFEST, name: '!!!', user_config: undefined };
    expect(() => importMcpBundle(makeBundle(manifest), '***.mcpb', {})).toThrow(/slug/);
  });

  it('mcp_definitions 同名冲突（非 bundle 行）→ 后缀 -2', () => {
    getDb()
      .prepare(
        `INSERT INTO mcp_definitions (id, name, version, transport, command, args, env, source)
         VALUES ('x1', 'demo-bundle', '1.0.0', 'stdio', 'node', '[]', '{}', 'custom')`,
      )
      .run();

    importMcpBundle(makeBundle(MCPB_MANIFEST), 'demo-bundle.mcpb', { api_key: 'k' });

    // 原手工注册行仍在，bundle 落 -2 后缀目录
    expect(getMcpConfig('demo-bundle')!.command).toBe('node');
    const cfg2 = getMcpConfig('demo-bundle-2');
    expect(cfg2).not.toBeNull();
    expect(cfg2!.cwd).toBe(path.join(bundlesRoot, 'demo-bundle-2'));
    const pkg = getDb()
      .prepare('SELECT item_id FROM installed_packages')
      .all() as Array<{ item_id: string }>;
    expect(pkg).toEqual([{ item_id: 'bundle:demo-bundle-2' }]);
  });

  it('slug 与 -2 … -20 后缀全部被占用 → 抛错且不落目录（错误路径专项）', () => {
    const insert = getDb().prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, args, env, source)
       VALUES (?, ?, '1.0.0', 'stdio', 'node', '[]', '{}', 'custom')`,
    );
    // 占满 base 与 -2 … -20 全部 20 个候选（i=1 无后缀，i=2…20 带后缀）
    insert.run('x1', 'demo-bundle');
    for (let i = 2; i <= 20; i++) {
      insert.run(`x${i}`, `demo-bundle-${i}`);
    }

    expect(() => importMcpBundle(makeBundle(MCPB_MANIFEST), 'demo-bundle.mcpb', {
      api_key: 'k',
    })).toThrow(/冲突超限/);
    // 拒绝发生在 rename 之前——正式目录零污染（也不留 .tmp- 残留）
    expect(fs.existsSync(bundlesRoot)).toBe(false);
    expect(getDb()
      .prepare("SELECT COUNT(*) AS c FROM installed_packages WHERE item_id LIKE 'bundle:%'")
      .get()).toEqual({ c: 0 });
  });

  it('导入成功后 mcp-bundles 目录只含 slug 目录（无 .tmp- 解包残留）', () => {
    importMcpBundle(makeBundle(MCPB_MANIFEST), 'demo-bundle.mcpb', { api_key: 'k' });
    expect(fs.readdirSync(bundlesRoot)).toEqual(['demo-bundle']);
  });

  it('幂等重导：同包重导复用 slug，目录覆盖，双表各一行', () => {
    const first = makeBundle(MCPB_MANIFEST);
    importMcpBundle(first, 'demo-bundle.mcpb', { api_key: 'k1' });

    // 第二次内容不同（多了 marker 文件、少了 server/index.js）——验证目录整体覆盖。
    // 直接手工构造（不走 makeBundle——它固定附加 server/index.js）
    const secondZip = new AdmZip();
    secondZip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify({ ...MCPB_MANIFEST, version: '2.0.0' }), 'utf-8'),
    );
    secondZip.addFile('marker.txt', Buffer.from('v2', 'utf-8'));
    importMcpBundle(secondZip.toBuffer(), 'demo-bundle.mcpb', { api_key: 'k2' });

    const bundleDir = path.join(bundlesRoot, 'demo-bundle');
    expect(fs.existsSync(path.join(bundleDir, 'marker.txt'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'server'))).toBe(false);

    const mcpCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM mcp_definitions WHERE name = 'demo-bundle'")
      .get() as { c: number };
    const pkgCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM installed_packages WHERE item_id = 'bundle:demo-bundle'")
      .get() as { c: number };
    expect(mcpCount.c).toBe(1);
    expect(pkgCount.c).toBe(1);
    // 第二次导入的 env 覆盖第一次
    expect(getMcpConfig('demo-bundle')!.env).toEqual({ API_KEY: 'k2' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// zip 安全（照抄 skill zip 规则 + bundle 侧拒绝语义）
// ────────────────────────────────────────────────────────────────────────────

describe('zip 安全', () => {
  it('非 zip 数据 → 拒绝', () => {
    expect(() => parseMcpBundle(Buffer.from('this is not a zip at all'), 'x.mcpb')).toThrow(
      /不是有效的/,
    );
  });

  it('条目名含 .. 段 → 拒绝', () => {
    expect(() => parseMcpBundle(makeRawEntryBundle('../evil.txt'), 'x.mcpb')).toThrow(/\.\./);
  });

  it('条目名是绝对路径 → 拒绝', () => {
    expect(() => parseMcpBundle(makeRawEntryBundle('/etc/passwd'), 'x.mcpb')).toThrow(
      /绝对路径/,
    );
  });

  it('条目数 > 2000 → 拒绝', () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(MCPB_MANIFEST), 'utf-8'));
    for (let i = 0; i < 2001; i++) {
      zip.addFile(`f${i}.txt`, Buffer.from('x', 'utf-8'));
    }
    expect(() => parseMcpBundle(zip.toBuffer(), 'x.mcpb')).toThrow(/条目数超限/);
  });

  it('解压总大小 > 200MB → 拒绝（高压缩零填充构造，parse 阶段即拦截不实际解压）', () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(MCPB_MANIFEST), 'utf-8'));
    // 201MB 零字节 buffer——deflate 后极小，但声明解压大小超限
    zip.addFile('big.bin', Buffer.alloc(201 * 1024 * 1024));
    expect(() => parseMcpBundle(zip.toBuffer(), 'x.mcpb')).toThrow(/大小超限/);
  });

  it('OS 元数据条目（__MACOSX 等）被忽略，不影响 manifest 判定', () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(MCPB_MANIFEST), 'utf-8'));
    zip.addFile('__MACOSX/._manifest.json', Buffer.from('junk', 'utf-8'));
    zip.addFile('.DS_Store', Buffer.from('junk', 'utf-8'));
    const preview = parseMcpBundle(zip.toBuffer(), 'demo-bundle.mcpb');
    expect(preview.name).toBe('demo-bundle');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 卸载清理（uninstallMcpBundle + isBundleInstalled）
// ────────────────────────────────────────────────────────────────────────────

describe('uninstallMcpBundle', () => {
  it('卸载：删 mcp_definitions 行 + rm cache_path 目录 + 删记账行；二次调用幂等', () => {
    importMcpBundle(makeBundle(MCPB_MANIFEST), 'demo-bundle.mcpb', { api_key: 'k' });
    const bundleDir = path.join(bundlesRoot, 'demo-bundle');
    expect(isBundleInstalled('demo-bundle')).toBe(true);

    uninstallMcpBundle('demo-bundle');

    expect(fs.existsSync(bundleDir)).toBe(false);
    expect(getMcpConfig('demo-bundle')).toBeNull();
    expect(isBundleInstalled('demo-bundle')).toBe(false);
    const pkgCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM installed_packages WHERE item_id = 'bundle:demo-bundle'")
      .get() as { c: number };
    expect(pkgCount.c).toBe(0);

    // 幂等：已卸载再调不抛
    expect(() => uninstallMcpBundle('demo-bundle')).not.toThrow();
  });

  it('isBundleInstalled：非 bundle 条目（手工注册 custom mcp）返回 false', () => {
    getDb()
      .prepare(
        `INSERT INTO mcp_definitions (id, name, version, transport, command, args, env, source)
         VALUES ('x1', 'plain', '1.0.0', 'stdio', 'node', '[]', '{}', 'custom')`,
      )
      .run();
    expect(isBundleInstalled('plain')).toBe(false);
  });
});
