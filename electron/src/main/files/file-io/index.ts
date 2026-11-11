// electron/src/main/files/file-io/index.ts
//
// FileIo 主进程单例与 boot 接线（spec §5.8）。主进程 WorkspaceFS 的默认内容
// 通道由本模块统一同步——所有既有构造点零改动。
//
// 本文件不 import 'electron'（与其他 file-io 模块同一约束，避免子进程可达图
// 触发模块解析）；electron app 经 loadElectronApis() 惰性取用并判空降级。
import { getGlobalSettings } from '../../settings/crud';
import { logger } from '../../logger';
import { loadElectronApis } from '../../electron-access';
import { setDefaultContentIo } from '../workspace-fs';
import { FileIoService } from './file-io-service';
import { resolveFileIoSettings, type FileIoConfig } from './file-io-settings';
import { DirectContentIo, ProxyContentIo } from './content-io';

let shared: FileIoService | null = null;

export function getFileIoService(): FileIoService {
  if (shared === null) {
    // 构造只取解析缺省（direct）——kv_store 读取收口在 syncFileIoDefaults 的
    // applySettings。这保证单例可在无 DB 环境构建（测试不触库不 throw）；
    // 生产 bootstrap 先于任何 IPC 流量跑 initFileIo()，设置在首笔流量前生效。
    shared = new FileIoService({
      settings: resolveFileIoSettings(),
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
  // loadElectronApis 恒返回 Partial（非 Electron 环境为空对象，不抛错）——
  // app 判空降级，与 git-policy.ts 的解构判空同法
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
