// electron/src/main/storage/migrations/060_plugin_hooks_audit.ts
//
// 插件系统 P3（spec 2026-10-15 §5.4）：hook 调用审计表 + preToolUse 决策列。
export interface Migration060 {
  version: number;
  up: string;
  down: string;
}

export const migration060: Migration060 = {
  version: 60,
  up: `
    -- hook 调用审计（spec §5.4：每次 hook 分发记 plugin/event/决策/耗时）
    CREATE TABLE hook_calls (
      id          TEXT PRIMARY KEY NOT NULL,
      plugin_id   TEXT NOT NULL,
      event       TEXT NOT NULL,
      -- preToolUse 订阅时的工具名 matcher（如 git_*）；其余事件 NULL
      matcher     TEXT,
      -- waterfall 决策 JSON（{action,reason?}）；无决策 NULL
      decision    TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      success     INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
      timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- preToolUse 决策摘要附工具调用审计条目（JSON 数组或 NULL=无 hook 参与）
    ALTER TABLE tool_calls ADD COLUMN pre_tool_use TEXT;
  `.trim(),
  down: `
    -- SQLite 旧版无 DROP COLUMN——down 仅文档化（测试直调仅验 up，惯例同 058/059）
  `.trim(),
};
