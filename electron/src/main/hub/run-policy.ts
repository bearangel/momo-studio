// electron/src/main/hub/run-policy.ts
//
// L0 权限档位语义单源（M2.1 T10，plan 契约区 PermissionTier）——三档在 worker
// 端委派会话上的运行时预配映射。纯函数模块（零 DB 零副作用），生产接线在
// delegation-ports.applyRunPolicyProduct。
//
// 三档语义（plan Task 10 契约）：
//   readonly = 零写授权（清会话级授权）+ 任务书前只读约束段
//   sandbox  = 预授予镜像工作空间目录写授权（既有写授权管理器 session 键）
//   confirm  = 不自动拒（现状默认——越界写走既有授权卡等待链）
//
// readonly 降级裁定（2026-10-26，任务书明示选此实用降级）→ **M2.2 P2-1 部分翻转
// （2026-10-27）**：原裁定「readonly 行为约束仅由任务书前置只读约束段承载」在
// **越界写工具调用**面上被翻转——该面（写授权硬门控等待链）现由主进程
// write-blocked 漏斗即时拒（sandbox/write-blocked-emit.ts：deny 广播解除子进程
// 等待 + denial 事件进 denied 进度拍，reason 文案见 READONLY_DENY_PREFIX）。
// 未翻转面：运行时无「只读工具集」开关（工具集为 agent 定义 YAML 的 defaultTools，
// 无会话级只读投影面），**workspace 内写不受授权门控**——仍由约束段承载（越界写
// 之外的落盘变更依赖 agent 行为契约 + 变更账本）。授权面 clearSessionGrants 显式
// 清零语义不变（防同键历史授权残留越权）。台账：M2.2 Rulings「2026-10-26 readonly
// 降级裁定被 P2-1 部分翻转」。预广播 denied（runtime-registry
// broadcastWriteGrantDenied）在 P2-1 起被采纳为即时拒的解除信号（原裁定中「只唤醒
// 在途等待者，对未来工具调用 no-op」的批评不适用于本面——即时拒恰是「等待已发生
// 即解除」语义）。
//
// 协议未知容忍：hub 1.2.0 parseDelegationTask 白名单重建 {title,prompt,agentSlug?}，
// permissionTier 在 hub 侧被剥离（2026-10-26 验证）——本端按可选字段容错消费
// （normalizeTier 缺省/非法收敛 confirm），未来 hub 升级透传后直接生效零改动。

/** HITL 权限档位（plan 契约区；dispatch-submit / delegation-runner / renderer 三端消费） */
export type PermissionTier = 'readonly' | 'sandbox' | 'confirm';

/** 档位→运行时预配映射（纯数据——生产端口按此执行授权动作，runner 按此组 prompt） */
export interface RunPolicyPlan {
  /**
   * 会话级写授权动作（接既有 sandbox/write-grant.ts 管理器，授权卡同源 API）：
   * clear-session       = 清空该会话写授权（readonly 显式零授权面）
   * grant-workspace-dir = 预授予镜像工作空间目录（sandbox 会话级键，随 deleteSession 清理）
   * none                = 不动授权面（confirm 不自动拒）
   */
  grant: 'clear-session' | 'grant-workspace-dir' | 'none';
  /** 回合任务书前置段；null = 不前置（sandbox/confirm 零注入） */
  promptPrefix: string | null;
}

/** readonly 档任务书前置只读约束段（明示违反后果——worker agent 的行为契约） */
export const READONLY_PROMPT_PREFIX =
  '【只读约束】本任务以只读模式委派：仅可执行读取、检索、分析类操作，禁止创建、修改或删除任何文件，禁止 git 写操作与其他形式的落盘变更。违反将被拒绝。';

/**
 * P2-1 即时拒文案前缀（deny reason 必含「只读档位」——spec §3 验收点）。
 * 消费方：write-blocked-emit 的 denial 事件（→ delegation-runner kind='denied'
 * 拍 excerpt → leader 看板进度行）。
 */
export const READONLY_DENY_PREFIX = '只读档位即时拒绝';

/** 即时拒 denial 摘要（command=写工具调用预览，截断由消费方按其上限处理） */
export function readonlyDenyExcerpt(command: string): string {
  return command !== '' ? `${READONLY_DENY_PREFIX}：${command}` : READONLY_DENY_PREFIX;
}

export function planRunPolicy(tier: PermissionTier): RunPolicyPlan {
  switch (tier) {
    case 'readonly':
      return { grant: 'clear-session', promptPrefix: READONLY_PROMPT_PREFIX };
    case 'sandbox':
      return { grant: 'grant-workspace-dir', promptPrefix: null };
    case 'confirm':
      return { grant: 'none', promptPrefix: null };
  }
}

/** 回合 body 组装：readonly 档前置只读约束段（约束段独立成段、任务书原文在后） */
export function composeTurnBody(tier: PermissionTier, prompt: string): string {
  const { promptPrefix } = planRunPolicy(tier);
  return promptPrefix === null ? prompt : `${promptPrefix}\n\n${prompt}`;
}

/** 协议未知容忍（异形载荷不抛）：合法档位透传，缺省/非法收敛 confirm */
export function isPermissionTier(v: unknown): v is PermissionTier {
  return v === 'readonly' || v === 'sandbox' || v === 'confirm';
}

export function normalizeTier(v: unknown): PermissionTier {
  return isPermissionTier(v) ? v : 'confirm';
}
