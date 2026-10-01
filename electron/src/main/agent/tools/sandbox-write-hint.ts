// electron/src/main/agent/tools/sandbox-write-hint.ts
// 沙箱 HOME 写拦截提示层（spec §7）：三条件（沙箱 tag × 写拒绝签名 × HOME 路径
// 特征）全命中时，bash 结果尾部追加固定提示——同时服务 LLM（知道该请求用户而非
// 绕路——2026-10-01 两起实证：.momo-scratch 本装与 /tmp 下载）与 renderer
// stream.store（固定子串检测置引导卡）。
const WRITE_DENY_SIGNATURES: readonly RegExp[] = [
  /EPERM/i,
  /Operation not permitted/i,
  /Permission denied/i,
  /Read-only file system/i,
];
const HOME_FEATURE = /(?:~\/|\$HOME\b|\/Users\/|\/home\/)/;

export function detectHomeWriteBlocked(tag: string, command: string, stderr: string): boolean {
  const sandboxed = /^(?:seatbelt|bwrap)\//.test(tag);
  if (!sandboxed) return false;
  const writeDenied = WRITE_DENY_SIGNATURES.some((re) => re.test(stderr));
  if (!writeDenied) return false;
  return HOME_FEATURE.test(command) || HOME_FEATURE.test(stderr);
}

export const WRITE_BLOCKED_HINT =
  '⚠ 非工作空间路径写入被沙箱拦截。若这是工具链/依赖的安装步骤：请让用户点击会话中的引导卡授权（本会话有效），或请用户在终端自行执行；用户操作后重试同一命令即可。不要尝试下载到临时目录或工作区缓存绕过——那对系统工具注册不可见。';
