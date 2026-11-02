// electron/tests/agent/tools/shell-tool-description.test.ts
// shell 工具描述按实测 shell 生成（spec 2026-11-02 §5.5）：
//   描述必须与模型实际拿到的 shell 一致——sandbox/windows.ts 的 detectWindowsShell
//   优先 pwsh.exe，pwsh 7 支持 && 且默认 UTF-8，绝不能对 PS 7 硬写「不支持 &&」。
// 平台经显式参数进入（不 mock process.platform，见 tests/platform/paths.win32.test.ts 文件头）。
import { describe, it, expect } from 'vitest';
import { shellToolDescription } from '../../../src/main/agent/tools/shell-tools';

describe('shellToolDescription', () => {
  it('win32 + Windows PowerShell 5.1：明确不支持 &&', () => {
    const d = shellToolDescription('win32', 'powershell.exe');
    expect(d).toContain('Windows PowerShell 5.1');
    expect(d).toContain('不支持 &&');
    expect(d).toContain(';');
  });

  it('win32 + pwsh 7：明确支持 &&', () => {
    const d = shellToolDescription('win32', 'pwsh.exe');
    expect(d).toContain('pwsh');
    expect(d).toContain('支持 &&');
  });

  it('win32 + 未探测：给中性文案与版本自检指引', () => {
    const d = shellToolDescription('win32', null);
    expect(d).toContain('$PSVersionTable.PSVersion');
  });

  it('win32 三种形态都写清写文件用无 BOM UTF-8，并警示不要用 >', () => {
    for (const s of ['powershell.exe', 'pwsh.exe', null] as const) {
      const d = shellToolDescription('win32', s);
      expect(d).toContain('UTF8Encoding');
      expect(d).toContain('不要用');
    }
  });

  it('posix：不提 PowerShell / BOM，且声明支持 &&', () => {
    const d = shellToolDescription('linux', null);
    expect(d).not.toContain('PowerShell');
    expect(d).toContain('&&');
  });
});
