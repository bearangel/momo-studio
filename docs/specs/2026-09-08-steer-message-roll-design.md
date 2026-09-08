# steer 注入消息滚动设计（message roll，v2.3.1）

- 日期：2026-09-08
- 状态：已批准（方向对话定稿）
- 上游：`docs/specs/2026-09-08-session-lane-steer-design.md`（§5 steer 注入链路）——本 spec 是其 §5.2 UI 边界的升级替换
- 背景：实测（2026-09-08 会话 b4ae75f3）确认 steer 功能语义正确，但「补充并入同一气泡 + 消息行 createdAt=流启动时刻」导致历史时间线出现「回复排在补充之前」的观感错位。用户裁定：注入后 agent 开新气泡完成任务。

## 1. 目标与非目标

**目标**：steer 注入时在流内「滚动换行」——当前消息行定格为完整气泡（done），新消息行承接后续输出（streaming），补充消息在平铺时间线中自然位于两个气泡之间。

**非目标**：
- 不改 steer 分流语义（`(sessionId, assignmentId)` 键、systemKickoff 豁免、死通道回退——上游 spec §5.1 不变）
- 不改车道 / abort / dispatch 链路（streamSessionId 不换，AgentRunner 活跃表与车道登记不受影响）
- 不做前一轮预览图中的方案 A/B/C（徽标、嵌套、注入点标记——本方案从排序层面根治，替代三者）
- 不复用 `task_complete` 的 segment 行机制（分段行是纯 body 快照且已被 2026-09-08 修复从渲染剔除；本方案是真换行）

## 2. 核心机制：流内消息滚动

### 2.1 wire format（子进程 → 主进程，新 chunk 类型）

```typescript
{ type: 'message_roll', streamSessionId }
```

与 abort/steer 同线协议模式（child IPC），由 runtime-entry 在 drain 点发出。

### 2.2 runtime-entry drain 扩展

```
for round 循环顶部：
  if (pendingSteers.length > 0) {
    if (hasNewTextSinceLastRoll) {
      sendStreamChunk({ type: 'message_roll', streamSessionId });
      hasNewTextSinceLastRoll = false;
    }
    // 注入补充消息（不变，逐条 user message）
    while (pendingSteers.length > 0) { messages.push(...) }
  }
```

- `hasNewTextSinceLastRoll`：本轮及之前产出过 text delta 即为 true（`case 'text'` 分支置位；roll 后复位）——防止「连续 steer 在同一等待期」产生空新行
- **切点时序安全**（设计保证 + 测试锁死）：drain 发生在「工具循环结束 → 下一轮 LLM 请求前」，此刻不存在悬空 tool_call/tool_result 事件对，切点无半开事务

### 2.3 stream-relay roll handler（主进程）

```
case 'message_roll': {
  const oldId = resolveMessageId(streamSessionId);   // 无行则静默跳过（与 start 前置同防御）
  if (!oldId) return;
  // ① 旧行终态化：复用 end 分支的聚合回写语义
  buf.flush();
  updateMessageStatus(oldId, 'done', aggregateTextDeltas(oldId));
  pushSessionMessage(getMessage(oldId));              // renderer 原位替换为静态气泡
  buf.append({ messageId: oldId, eventType: 'final', payload: { body } });
  buf.flush();
  // ② 新行：sessionId/sender/eventType 继承旧行，streamSessionId 加 roll 后缀
  const rollMsg = insertMessage({ ..., streamSessionId: `${streamSessionId}#roll${n}`, body: '', status: 'streaming' });
  streamMessageIdCache.set(streamSessionId, rollMsg.id);  // 后续 thinking/text/tool/end 全部落新行
  pushSessionMessage(rollMsg);
  buf.append({ messageId: rollMsg.id, eventType: 'status_change', payload: { status: 'streaming' } });
}
```

关键点：
- **roll 计数 n**：主进程维护 per-streamSessionId 计数（内存 Map，同 streamSessionId 可多次 roll；end chunk 的 `clearStreamSessionCache` 一并清理，防泄漏）
- **旧行 stream_session_id 保留**（历史关联），新行用 `#roll{n}` 后缀（与 segment 的 `#seg{n}` 后缀同法）——避免 `getMessageByStreamSessionId` 双行歧义
- 后续所有 chunk 经 `resolveMessageId(streamSessionId)` → cache → 新行，**零改动**自动换乘
- end chunk 到达时终态回写落新行（`aggregateTextDeltas(newId)` 只聚新行 events）✓

### 2.4 renderer：零改动

- 新行以 `status:'streaming'` 经 `pushSessionMessage` 插入 → `MessageBubble` 按 `message.id` 查 stream store → 自动渲染为新的 `AgentStreamBubble`（新气泡从注入时刻开始流式）
- 旧行 done + final event → 原位替换定格为静态气泡
- 平铺时间线顺序（createdAt 升序）：用户消息 → 气泡① → 补充消息 → 气泡②——**时序观感从排序层面根治**

## 3. 架构红利（为什么改动面小）

1. **events 按 messageId 分桶**：注入前 thinking/tool/text 全挂旧行，注入后全挂新行——重启重放（`hydrateFromEvents` 按 message 分桶）、复制/导出（body 各自聚合）、流式渲染三条路径自动成立，零特殊处理
2. **MessageBubble 按行查流状态**：新行自动获得流式气泡，无需新组件

## 4. 边界与错误处理

| 场景 | 行为 |
|---|---|
| steer 到达但自上次 roll 后无新文本 | 跳过 roll 只注入（防空行），补充进入当前行上下文 |
| 多条 steer 同轮 drain | 一次 roll + 全量 FIFO 注入（不逐条 roll） |
| roll 后流被 abort | end(interrupted) 落新行；旧行保持 done（已定格部分输出）——语义：注入前的工作完整保留，注入后的工作显示中断态 |
| 最后一轮自然结束后 steer 未消费 | 上游 spec §5.4 沉淀语义不变（不重派发） |
| dispatch 子流 | steer 分流层已挡（不进本链路） |
| 旧行聚合为空文本（roll 时全程无 text） | `hasNewTextSinceLastRoll` 守卫已防（无 text 则不 roll） |
| P2P 远端 | agent 消息行本就不走 LAN 广播（仅用户消息与任务快照同步）——新旧行行为一致，零改动 |
| 主进程在 roll handler 中 DB 失败 | 沿用 routeChunkToBuffer 既有 catch：DB 未就绪 debug 跳过 / 真实故障 error 记录不中断中继 |

## 5. 测试策略

**electron 主进程**：
- stream-relay roll handler：旧行 done + body 聚合回写 + 推送；新行插入（streaming + `#roll{n}` 后缀）；cache 换指向后 text/end 落新行；旧行 stream_session_id 保留；多次 roll 计数递增；无旧行静默跳过
- runtime-entry：drain 有新文本 → 发 roll chunk 后注入；无新文本 → 只注入不发 roll；多条 steer 一次 roll；roll 不影响 abort 语义（roll 后 abort → 新行 interrupted）
- 集成：roll 前后 events 分桶正确（旧行/新行各自重放 == 实时聚合，restart-consistency 模式）

**renderer**：
- MessageList/MessageBubble 既有测试无回归（分段行过滤逻辑不受影响——roll 行 `segmentOf` 为 null，正常渲染）

## 6. 验收标准

1. 活跃流期间手输补充：出现两个 agent 气泡——①在注入点定格（含此前全部输出）、②从注入时刻流式续跑；补充消息位于两气泡之间
2. 会话导出：4 条消息（用户 / 气泡① / 补充 / 气泡②），时间顺序自然，无「回复在补充前」错位
3. steer 分流 / 车道排队 / abort / dispatch 并行全部零回归（上游特性测试全绿）
4. typecheck 双 clean；全量测试绿

## 7. 实施切片建议

1. **T1**：stream-chunk `message_roll` 类型 + stream-relay roll handler + 单测
2. **T2**：runtime-entry drain 扩展（`hasNewTextSinceLastRoll` + roll emit）+ runtime-entry-steer 测试扩展
3. **T3**：门禁（typecheck + 全量测试 + macOS 冒烟清单：实测会话场景复现双气泡）

依赖序：T1 → T2 → T3 串行。
