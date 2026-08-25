---
name: momo-debug-rules
description: Momo Studio 修 bug / 排查异常行为的强制流程规则。Use when 修 bug、排查问题、为什么不工作、报错、复现、修复无效、根因分析。主机验收 8 个 P0 的教训沉淀。
---

# Momo Studio 排查修复规则

修 bug 前必须遵守。每条规则都来自真实翻车（案例见 `docs/dev/rules/engineering.md`）。

## 强制流程（按序执行）

1. **先复现，后修复**。无法复现时升级复现手段，而不是先猜先改：
   - L1 容器 harness：直接驱动生产代码（import dist 产物，不走 mock）
   - L2 真实 LLM e2e：seed SQLite → 启动生产链路 → 轮询断言落库结果
   - L3 真机探针：`xvfb-run` + `--remote-debugging-port` + CDP WebSocket 查真实 DOM/store
2. **「修复无效」三查**（用户说没效果时，先查环境再怀疑代码）：
   - `git log --oneline -1`：代码到了吗
   - `grep -c "<新代码特征串>" electron/dist/main/**/*.js`：主进程产物新吗
   - renderer 改动必须确认 `renderer/dist` 重建过（或已用 `pnpm dev` 走 HMR）
   - 同类坑：electron 主进程改动必须重启 electron（tsc watch 不重载进程）；better-sqlite3 ABI 横跳（Node ↔ Electron）
3. **数据争议 SQLite 直查裁决**。UI 观感 ≠ 数据事实：「消息丢失」「没落库」先用 sqlite3 查 messages/message_events 表。WAL 数据在 -wal 文件——拷库要三件套或先 checkpoint。
4. **运行时黑盒加探针**。UI/主进程状态不可见时，加诊断钩子（如 renderer 的 `__momoDebug()` 挂 globalThis，DevTools 一键导出 store 状态），让用户提供决定性输出。
5. **跨层根因逐层断言**。在 harness 里对每一层单独 verify（DB 行字段 → 事件 payload → 查找键匹配），别只验最终现象。
6. **修复必须带回归锁**：先写失败测试（红）→ 修（绿）。回归锁本身要遵守 momo-test-rules 的保真度规则。

## 案例摘要（症状 → 根因 → 规则）

- agent 永不回复 + 无任何报错 → `process.send` 解构裸调用丢 this 崩在错误路径，mock 不读 this 漏网 → 规则 6 + test-rules
- 连续两轮「修复无效」→ 用户跑的是旧 renderer/dist → 规则 2
- 「消息丢失」→ 数据全在库里，是渲染层幽灵状态 → 规则 3
- 嵌套展开永远空（代码全对）→ 用户在普通会话测试，dispatch 路由到 teamSessionId → 规则 5 逐层断言 + __momoDebug 输出定位
- dev 起了但 app 不启动 → fetch 探测被 HTTP_PROXY 劫持 → 环境分歧也是根因之一，别只查代码

## 反模式（禁止）

- ❌ 「看起来是 X，改了试试」——未复现就动手
- ❌ 改完只跑单测就宣称修复——跨进程链路必须有落库/DOM 级验证
- ❌ 连续第 3 次修复尝试——停，回规则 1 重新排查（系统性调试纪律）
- ❌ 让用户反复当测试员——先用容器复现，用户只做最终确认
