---
name: momo-boundary-rules
description: Momo Studio 跨模块 / IPC / 协议字段 / 事件契约的修改规则。Use when 改 IPC、跨模块数据流、协议字段、事件类型、streamSessionId、dispatch、消息契约、生产者消费者。8 个 P0 中 4 个源于契约漂移。
---

# Momo Studio 跨边界契约规则

改 IPC 通道、跨模块传递的数据结构、事件类型前必须检查。教训：**单模块内代码正确 ≠ 链路正确**——8 个 P0 里一半是「两端各自都对，对接面错了」。

## 五条铁律

1. **跨模块 ID 单点生成、沿线透传，禁止中途回收再生成**。
   一个 ID 的生命周期：生成点 → 每一跳显式传递 → 消费点。任何一跳「自己再生成一个同用途 ID」= 断链。
   案例：PM 预生成 subStreamSessionId 发给 renderer 作查找键，routeDispatch 却自造新 UUID 作子任务流 id——嵌套展开永远空（P0-7）。
2. **「等待某事件/字段」的代码必须验证生产者存在**。写消费方前 grep 生产方：这个事件类型真的有 emit 点吗？payload 字段真的被写入吗？
   案例：renderer 聚合器等 `dispatch_start` 事件——生产链路从不产生它（实际是 `tool_call_start` 带 `isDispatch:true`）（P0-6）。
3. **一义一名，语义漂移即 bug**。字段含义变了就改名或加新字段，禁止「同名字段悄悄换语义」。
   案例：`tool_stream_session_id` 一字段两义（子流 id？PM 流 id？）——两端理解相反（P0-7）。
4. **生产者/消费者成对修改**：改协议字段两端同步改 + 补契约测试（见 momo-test-rules 第 4 条）。半边修改 = 定时炸弹。
5. **路由/关联目标用当前上下文，不用配置默认值**。
   案例：executeDispatch 用 `config.teamSessionId` 发事件——用户在普通会话触发时，子 agent 消息全落团队会话，当前会话永远查不到（P0-8）。

## 本仓高频契约面（改动前自查）

- `StreamChunk`（runtime 子进程 → stream-relay）：type/sessionId/senderAgentId/streamSessionId
- `MessageEventRow`（event-buffer → renderer 聚合）：eventType/payload 形状、id/seq 唯一性
- `DispatchContent`（dispatch-wait → router-service）：sub_stream_session_id / tool_stream_session_id 双流 id 语义
- `ImMessage`（messages 表 → IPC → renderer）：streamSessionId / parentStreamSessionId 嵌套关联
- 预加载三层 `../../../` 引用 renderer 类型——改 IPC 接口两个 workspace 都要 typecheck

## 修改协议字段的标准动作

```
1. 列出该字段的全部生产点 + 消费点（grep 字段名）
2. 决定：新增 / 改义 / 废弃（优先新增，向后兼容旧消费者）
3. 两端同 commit 修改 + 契约测试锁形状
4. 跨workspace 改动跑双 typecheck
```
