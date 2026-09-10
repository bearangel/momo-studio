// electron/src/main/agent/tools/shared/edit-recovery.ts
// v2.3 edit_file 失败信息增强：原文前 5KB 快照 + 首次不一致行号 + 建议 read_file 重试。

const SNAPSHOT_BYTES = 5 * 1024; // 5KB 快照上限

/**
 * 格式化 edit_file 失败错误信息。
 * 包含：失败类型 + 文件路径 + 首次不一致行号 + 原文前 5KB 快照 + read_file 重试建议。
 */
export function formatEditError(
  kind: 'not_found' | 'not_unique',
  path: string,
  oldString: string,
  fileContent: string,
  occurrences?: number,
): Error {
  const hint = kind === 'not_unique' && occurrences !== undefined
    ? `oldString 在文件中出现 ${occurrences} 次，请添加更多上下文使其唯一。`
    : 'oldString 未在文件中找到。请重新调用 read_file 读取最新内容后重试。';

  const line = findFirstMismatchLine(fileContent, oldString);
  const head = fileContent.slice(0, SNAPSHOT_BYTES);

  const message = [
    `edit_file 失败 (${kind}): ${hint}`,
    `文件: ${path}`,
    `首次不一致行号: ${line ?? 'N/A'}`,
    '---',
    '原文件前 5KB 快照:',
    head,
    '---',
    `建议: 调用 read_file 重新读取 ${path} 后重试`,
  ].join('\n');

  return new Error(message);
}

/**
 * 查找 oldString 第一行在 fileContent 中最早出现的 1-based 行号。
 * 找不到则返回 null（边界：内容过短或 oldString 多行）。
 */
function findFirstMismatchLine(fileContent: string, oldString: string): number | null {
  const oldFirstLine = oldString.split('\n', 1)[0];
  if (!oldFirstLine || oldFirstLine.length === 0) return null;
  const lines = fileContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.includes(oldFirstLine)) return i + 1;
  }
  return null;
}
