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
