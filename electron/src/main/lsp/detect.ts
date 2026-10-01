// workspace 语言检测（spec §9）——主进程单一真相源：
//   消费方 A：spawn 时 activeLanguageIds 快照注入 AGENT_CONFIG.lspLanguages
//   消费方 B：lsp:status 面板
import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY, findBinaryInPath, type LanguageServerSpec } from './registry';
import { getLspRunState, type LspRunState } from './run-state';

/** marker 求值跳过的目录名（依赖目录里遍地 go.mod/tsconfig） */
export const SKIP_DIRS: readonly string[] = [
  'node_modules', '.git', 'dist', 'build', 'vendor', 'out',
];

export interface LanguageStatus {
  languageId: string;
  label: string;
  tier: 'verified' | 'experimental';
  toolchain: boolean;
  binary: boolean;
  running: LspRunState;
  installHint: string;
}

/** 单段 glob 匹配（仅 `*`）：`a/*.csproj` / `*.sh` / `tsconfig.json` */
function matchSegments(pattern: string[], target: string[]): boolean {
  if (pattern.length !== target.length) return false;
  return pattern.every((p, i) =>
    p === '*' ? true : p.includes('*') ? globSeg(p, target[i]!) : p === target[i],
  );
}
function globSeg(pat: string, s: string): boolean {
  const parts = pat.split('*');
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    const at = s.indexOf(parts[i]!, idx);
    if (at < 0 || (i === 0 && at !== 0)) return false;
    idx = at + parts[i]!.length;
  }
  return true;
}

/** markers 求值：根 + 一层子目录（跳过 SKIP_DIRS） */
export function markersHit(workspaceDir: string, markers: string[]): boolean {
  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(workspaceDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const rootNames = rootEntries.filter((e) => e.isFile()).map((e) => e.name);
  const subDirs = rootEntries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.includes(e.name))
    .map((e) => e.name);
  for (const marker of markers) {
    const segs = marker.split('/');
    if (segs.length === 1) {
      if (rootNames.some((n) => matchSegments([marker], [n]))) return true;
    } else {
      // 一层子目录形态：*/go.mod、requirements*.txt 不含斜杠——双段仅此形态
      for (const d of subDirs) {
        let names: string[];
        try {
          names = fs.readdirSync(path.join(workspaceDir, d)).filter((f) => {
            try { return fs.statSync(path.join(workspaceDir, d, f)).isFile(); } catch { return false; }
          });
        } catch { continue; }
        if (names.some((n) => matchSegments(segs.slice(1), [n]))) return true;
      }
    }
  }
  return false;
}

const cache = new Map<string, LanguageStatus[]>();

function buildStatuses(workspaceId: string, workspaceDir: string, envPath?: string): LanguageStatus[] {
  return REGISTRY.map((spec: LanguageServerSpec) => ({
    languageId: spec.languageId,
    label: spec.label,
    tier: spec.tier,
    toolchain: markersHit(workspaceDir, spec.markers),
    binary: findBinaryInPath(spec.binaries, envPath) !== null,
    running: getLspRunState(workspaceId, spec.languageId),
    installHint: spec.installHint,
  }));
}

export function detectWorkspaceLanguages(
  workspaceId: string,
  workspaceDir: string,
  envPath?: string,
): LanguageStatus[] {
  let c = cache.get(workspaceId);
  if (!c) {
    c = buildStatuses(workspaceId, workspaceDir, envPath);
    cache.set(workspaceId, c);
  }
  return c;
}

export function redetectWorkspaceLanguages(
  workspaceId: string,
  workspaceDir: string,
  envPath?: string,
): LanguageStatus[] {
  const c = buildStatuses(workspaceId, workspaceDir, envPath);
  cache.set(workspaceId, c);
  return c;
}

/** ready 集 → AGENT_CONFIG.lspLanguages 快照（实验层命中亦进） */
export function activeLanguageIds(statuses: LanguageStatus[]): string[] {
  return statuses.filter((s) => s.toolchain && s.binary).map((s) => s.languageId);
}