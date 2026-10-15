// electron/src/main/paths.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function defaultUserDataDir(): string {
  return path.join(os.homedir(), '.momo-studio');
}

export function resolveUserDataDir(): string {
  const dir = process.env.AP_USER_DATA_DIR ?? defaultUserDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function resolveDbPath(): string {
  return path.join(resolveUserDataDir(), 'state.db');
}

export function resolveLogsDir(): string {
  const dir = path.join(resolveUserDataDir(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function resolveSkillsDir(): string {
  const dir = path.join(resolveUserDataDir(), 'skills');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 临时文件目录（<userData>/tmp；git 导入等中转用途，AP_USER_DATA_DIR 注入可测） */
export function resolveTmpDir(): string {
  const dir = path.join(resolveUserDataDir(), 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 插件子系统根目录 <userData>/plugins/（spec 2026-10-15 §7.1，AP_USER_DATA_DIR 注入可测） */
export function resolvePluginsDir(): string {
  const dir = path.join(resolveUserDataDir(), 'plugins');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolvePluginInstalledDir(id: string, version: string): string {
  return path.join(resolvePluginsDir(), 'installed', id, version);
}

/** 跨更新持久数据目录 <userData>/plugins/data/<id>/（卸载时按 keepData 决定去留） */
export function resolvePluginDataDir(id: string): string {
  return path.join(resolvePluginsDir(), 'data', id);
}
