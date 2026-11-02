// electron/tests/agent/tools/shell-tool-description.test.ts
// shell 工具描述按实测 shell 生成（spec 2026-11-02 §5.5）：
//   描述必须与模型实际拿到的 shell 一致——sandbox/windows.ts 的 detectWindowsShell
//   优先 pwsh.exe，pwsh 7 支持 && 且默认 UTF-8，绝不能对 PS 7 硬写「不支持 &&」。
//   反过来，win32 描述也不得携带 bwrap/seatbelt 专属断言（/tmp 写面、ps/kill 拦截、
//   & 后台、LaunchServices）——PowerShell 里照做只会拿到 CommandNotFoundException。
// 平台经显式参数进入（不 mock process.platform，见 tests/platform/paths.win32.test.ts 文件头）。
import { describe, it, expect } from 'vitest';
import { shellToolDescription } from '../../../src/main/agent/tools/shell-tools';

describe('shellToolDescription', () => {
  it('win32 + Windows PowerShell 5.1：串联用 ;，明确不支持 &&', () => {
    const d = shellToolDescription('win32', 'powershell.exe');
    expect(d).toContain('Windows PowerShell 5.1');
    expect(d).toContain('串联用 ;');
    expect(d).toContain('不支持 &&');
    // 5.1 文案不得混入 7 的事实（否则两分支互换测试仍绿）
    expect(d).not.toContain('PowerShell 7');
  });

  it('win32 + pwsh 7：明确支持 &&', () => {
    const d = shellToolDescription('win32', 'pwsh.exe');
    expect(d).toContain('PowerShell 7（pwsh.exe）');
    expect(d).toContain('支持 &&');
    // 关键回归锁：把 pwsh 与 powershell.exe 两支文案互换，本用例必须变红
    expect(d).not.toContain('不支持');
    expect(d).not.toContain('Windows PowerShell 5.1');
  });

  it('win32 + 未探测：说明回退到 powershell.exe，并保留版本自检指引', () => {
    const d = shellToolDescription('win32', null);
    expect(d).toContain('$PSVersionTable.PSVersion');
    // 未探测时 sandbox/index.ts 的 win32 分支实际回退到系统自带 powershell.exe
    expect(d).toContain('回退到');
    expect(d).toContain('powershell.exe');
    expect(d).toContain('node / python / npm / git 可直接调用');
  });

  it('win32 未知 shell 值（如 cmd.exe）与未探测同文案', () => {
    expect(shellToolDescription('win32', 'cmd.exe')).toBe(shellToolDescription('win32', null));
  });

  it('win32 三种形态都写清写文件用无 BOM UTF-8，并警示不要用 >', () => {
    for (const s of ['powershell.exe', 'pwsh.exe', null] as const) {
      const d = shellToolDescription('win32', s);
      expect(d).toContain('UTF8Encoding');
      expect(d).toContain('不要用');
    }
  });

  it('win32 三形态都不携带 POSIX 专属断言（/tmp、ps/kill/lsof、& 后台、LaunchServices）', () => {
    for (const s of ['powershell.exe', 'pwsh.exe', null] as const) {
      const d = shellToolDescription('win32', s);
      for (const banned of ['/tmp', 'lsof', 'pkill', 'LaunchServices', '& 启动', '只传 PATH/HOME']) {
        expect(d, `win32/${String(s)} 不应包含 ${banned}`).not.toContain(banned);
      }
      // 反过来必须说清 Windows 的真实姿态：无 OS 沙箱
      expect(d).toContain('Windows 无 OS 沙箱');
    }
  });

  it('env 白名单提示按平台陈述真实变量名（win32 清单里没有 HOME）', () => {
    const win = shellToolDescription('win32', 'pwsh.exe');
    expect(win).toContain('Path / PATHEXT');
    expect(win).not.toContain('只传 PATH/HOME');
    const posix = shellToolDescription('linux', null);
    expect(posix).toContain('只传 PATH/HOME');
  });

  it('posix：不提 PowerShell / BOM，且声明支持 &&', () => {
    const d = shellToolDescription('linux', null);
    expect(d).not.toContain('PowerShell');
    expect(d).toContain('&&');
  });

  // 逐字快照锁：win32 拆分不得削弱 posix 文本（顺序与措辞均不动）
  it('posix：沙箱 / 进程语义逐字保留（win32 拆分零影响）', () => {
    const expected = [
      '在 workspace 根目录执行 shell 命令（受 OS 沙箱约束：读全盘但敏感目录不可读、仅可写 workspace 与 /tmp；网络出站按沙箱设置双态——永久允许（默认）/拒绝）。',
      '沙箱内无法启动 GUI 应用与系统浏览器（open/LaunchServices 被拒）——需要打开网页时用 browser_navigate 等浏览器工具。',
      '30s 超时，stdout+stderr 各截断 10KB。退出码非 0 不抛错。每条命令独立 shell，cd 不持久。',
      '后台进程（& 启动）在本回合内可跨命令存活，回合结束时由平台统一回收——不要依赖跨回合的后台服务（下回合需重启）。',
      '沙箱内 ps 与 kill 系统调用被拦截（kill -0/pkill 会误报「进程已死/无权限」）：查自己启动的进程用 process_list，判端口占用用 lsof/curl，关闭自己启动的服务用 process_kill（bash 里 kill 必失败）。',
      '支持 && 串联；外部程序从 PATH 解析。',
      '环境变量是受限白名单：只传 PATH/HOME 等基础变量，不要依赖 PATH 以外的自定义变量（自设的 API key 等取不到，需要时走专用工具）。',
    ].join('');
    expect(shellToolDescription('linux', null)).toBe(expected);
    // 非 win32 同一条 posix 文案（darwin 不受影响）
    expect(shellToolDescription('darwin', null)).toBe(expected);
  });
});
