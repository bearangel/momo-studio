// electron/src/main/agent/tools/apply-patch-parser.ts
// v2.3 V4A PEG parser（自写，约 150 行）。子集：add / update / delete 三头，
// 不含 Move to（spec §10 边界决策）。Streaming-ready：行式扫描，可改造为流式。

/** 单个 op 的结构化表示 */
export type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'update'; path: string; hunk: Hunk }
  | { kind: 'delete'; path: string };

/** update op 的 hunk（带 anchor + 改动行序列） */
export interface Hunk {
  anchor: string;
  changes: Array<{ kind: ' ' | '-' | '+'; text: string }>;
}

/** 完整 patch AST */
export interface PatchAst {
  ops: PatchOp[];
}

/**
 * 解析 V4A patch 文本。失败抛 Error 含位置（行号）。
 * 与 Codex CLI / Cline 的 apply_patch V4A 子集对齐。
 */
export function parsePatch(input: string): PatchAst {
  if (input.trim().length === 0) {
    throw new Error('V4A patch 解析失败：内容为空');
  }

  const lines = input.split('\n');
  // 末尾换行产生的空尾行不是内容行（无它则所有以 "\n" 结尾的正常 patch 都会
  // 在空行处误抛错）；仅剥掉这一个由最终换行派生的元素，其余空行仍严格报错。
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  const ops: PatchOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const header = lines[i];
    if (header === undefined) break;
    if (!header.startsWith('*** ')) {
      throw new Error(`V4A patch 第 ${i + 1} 行错误：期望 "*** Op:" header，得到 "${header}"`);
    }
    if (header.startsWith('*** Add File:')) {
      const path = header.slice('*** Add File:'.length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const line = lines[i]!;
        if (!line.startsWith('+')) {
          throw new Error(`+ 前缀缺失：V4A patch 第 ${i + 1} 行 add 行必须以 "+" 开头，得到 "${line}"`);
        }
        contentLines.push(line.slice(1));
        i++;
      }
      ops.push({ kind: 'add', path, content: contentLines.join('\n') + (contentLines.length > 0 ? '\n' : '') });
    } else if (header.startsWith('*** Delete File:')) {
      const path = header.slice('*** Delete File:'.length).trim();
      ops.push({ kind: 'delete', path });
      i++;
    } else if (header.startsWith('*** Update File:')) {
      const path = header.slice('*** Update File:'.length).trim();
      i++;
      const anchorLine = lines[i];
      if (anchorLine === undefined || !anchorLine.startsWith('@@ ')) {
        throw new Error(`V4A patch 第 ${i + 1} 行错误：update 必须有 hunk（"@@" anchor 行）`);
      }
      const anchor = anchorLine.slice('@@'.length).trim();
      i++;
      const changes: Hunk['changes'] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ') && !lines[i]!.startsWith('@@ ')) {
        const line = lines[i]!;
        const marker = line[0];
        if (marker !== ' ' && marker !== '-' && marker !== '+') {
          throw new Error(`V4A patch 第 ${i + 1} 行错误：update 行必须以 " "/"-" "+" 开头，得到 "${line}"`);
        }
        changes.push({ kind: marker, text: line.slice(1) });
        i++;
      }
      ops.push({ kind: 'update', path, hunk: { anchor, changes } });
    } else {
      throw new Error(`V4A patch 解析失败：未知 op "${header}"`);
    }
  }

  if (ops.length === 0) {
    throw new Error('V4A patch 解析失败：无有效 op');
  }

  return { ops };
}
