// electron/tests/agent/tools/officepro/generation-smoke.test.ts
//
// 生成冒烟（spec 2026-11-03 §9.2 前置）：真 vendor + 真 run_js 链路。
// vendor 未构建时整体 skip（提示先跑 build.sh）——CI 无 vendor 不红，本地验收必跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSandboxStateForTest } from '../../../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../../../src/main/sandbox/settings';
import { execSandboxed } from '../../../../src/main/agent/tools/shared/sandboxed-exec';
import { loadPluginToolModules } from '../../../../src/main/agent/tools/plugin-tools';
import type { PluginToolRef } from '../../../../src/main/agent/runtime-config';
import type { ToolContext } from '../../../../src/main/agent/tools/types';
import { ReadTracker } from '../../../../src/main/agent/tools/shared/read-tracker';
import { WorkspaceFS } from '../../../../src/main/files/workspace-fs';
import { PLUGIN_ROOT } from './fixtures';

const VENDOR_OK = fs.existsSync(path.join(PLUGIN_ROOT, 'vendor/node_modules/pptxgenjs'));

describe.skipIf(!VENDOR_OK)('office-pro 生成冒烟（真 vendor 全链路；未构建请先跑 scripts/build.sh）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-smoke-'));
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });

  beforeEach(() => {
    __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
    __setSandboxStateForTest({ platform: process.platform, sandboxTool: null, toolVersion: null, available: false, unavailableReason: '单测钉 plain', windowsShell: null, executionPolicy: null, probedAt: 0 });
  });
  afterEach(() => {
    __setSandboxStateForTest(null);
    __setSandboxSettingsForTest(null);
  });

  function mkCtx(): ToolContext & { __journal: Array<{ rel: string; op: string }> } {
    const journal: Array<{ rel: string; op: string }> = [];
    const ctx = {
      wsFs: new WorkspaceFS(wsDir),
      workspaceId: 'ws1',
      workspaceDir: wsDir,
      skillRegistry: {} as ToolContext['skillRegistry'],
      streamSessionId: 's',
      roomId: 'r',
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [], deniedTools: [] },
      creatorUserId: '',
      execSandboxed,
      recordFileChange: (_t: string, rel: string, op: string) => { journal.push({ rel, op }); },
      readTracker: new ReadTracker(),
      __journal: journal,
    } as ToolContext & { __journal: Array<{ rel: string; op: string }> };
    return ctx;
  }

  function loadTools() {
    const ref: PluginToolRef = {
      pluginId: 'office-pro', rootDir: PLUGIN_ROOT,
      modulePaths: [path.join(PLUGIN_ROOT, 'tools/run_js.js')],
      dataDir: path.join(tmp, 'data'), config: {},
    };
    const { modules, failures } = loadPluginToolModules([ref], vi.fn());
    expect(failures).toHaveLength(0);
    return modules[0]!;
  }

  it('pptxgenjs：run_js 产出 2 页 pptx → momo-validate ok + 记账 create', { timeout: 90000 }, async () => {
    const m = loadTools();
    const ctx = mkCtx();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `
        const PptxGenJS = require('pptxgenjs');
        const pptx = new PptxGenJS();
        pptx.defineLayout({ name: 'W', width: 10, height: 5.625 });
        pptx.layout = 'W';
        pptx.addSlide().addText('冒烟标题', { x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontSize: 28, bold: true, color: '2D3436' });
        pptx.addSlide().addText('第二页', { x: 0.6, y: 0.5, w: 8.8, fontSize: 18 });
        await pptx.writeFile({ fileName: 'smoke.pptx' });
        const path = require('path');
        const { validateOfficeFile } = require('momo-validate');
        console.log('VALIDATE=' + JSON.stringify(validateOfficeFile(path.resolve('smoke.pptx'))));
      `,
      outputs: ['smoke.pptx'],
      timeout_ms: 60000,
    }, ctx);
    expect(r).toContain('退出码=0');
    expect(r).toContain('VALIDATE={"ok":true');
    expect(r).toContain('smoke.pptx: create 已记账');
    expect(ctx.__journal).toEqual([{ rel: 'smoke.pptx', op: 'create' }]);
    expect(fs.existsSync(path.join(wsDir, 'smoke.pptx'))).toBe(true);
  });

  it('exceljs + momo-chart：xlsx + 原生图表注入 → validate ok + chart 部件存在', { timeout: 90000 }, async () => {
    const m = loadTools();
    const ctx = mkCtx();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `
        const ExcelJS = require('exceljs');
        const { injectXlsxChart } = require('momo-chart');
        const fs = require('fs');
        const path = require('path');
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('数据');
        ws.addRow(['季度', '销量']); ws.addRow(['Q1', 120]); ws.addRow(['Q2', 180]); ws.addRow(['Q3', 150]);
        await wb.xlsx.writeFile('smoke.xlsx');
        const buf = fs.readFileSync('smoke.xlsx');
        fs.writeFileSync('smoke.xlsx', injectXlsxChart(buf, {
          sheetName: '数据',
          anchor: { from: { col: 3, row: 1 }, to: { col: 9, row: 16 } },
          chart: { type: 'bar', title: '季度销量', series: [{ nameLiteral: '销量', catRef: '数据!$A$2:$A$4', catCache: ['Q1','Q2','Q3'], valRef: '数据!$B$2:$B$4', valCache: [120,180,150] }] },
        }));
        const AdmZip = require('adm-zip');
        const zip = new AdmZip('smoke.xlsx');
        console.log('CHART=' + zip.getEntries().some((e) => e.entryName.includes('charts/chart1.xml')));
        const { validateOfficeFile } = require('momo-validate');
        console.log('VALIDATE=' + JSON.stringify(validateOfficeFile(path.resolve('smoke.xlsx'))));
      `,
      outputs: ['smoke.xlsx'],
      timeout_ms: 60000,
    }, ctx);
    expect(r).toContain('退出码=0');
    expect(r).toContain('CHART=true');
    expect(r).toContain('VALIDATE={"ok":true');
    expect(fs.existsSync(path.join(wsDir, 'smoke.xlsx'))).toBe(true);
  });
});
