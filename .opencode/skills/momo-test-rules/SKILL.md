---
name: momo-test-rules
description: Momo Studio 写测试 / 构造 mock / 回归锁的保真度规则。Use when 写测试、单测、vi.mock、mock、stub、断言、回归锁、测试失败排查。防止「测试全绿但生产崩」。
---

# Momo Studio 测试保真度规则

写测试或 mock 前必须检查。核心教训：**1074 个测试全绿，8 个 P0 照样进生产**——问题不在覆盖率，在保真度。

## 五条铁律

1. **Mock 必须仿真真实运行时语义**。「方便测试」的简化 = 埋雷：
   - mock `process.send` 等方法型 API 时必须校验 `this` 绑定（真实 Node 内部读 `this.connected`，裸调用即崩）
   - mock 产出的 ID 必须真实唯一（真实实现用 randomUUID，mock 给固定占位符 = 消费方去重逻辑全部误杀）
   - async 时序、错误形状（Error vs string rejection）同样仿真
2. **断言生产消费的字段**。被消费方使用的字段（id/seq/status）就在测试里断言其真实性质，不接受「调用方不应该依赖它」的占位符。
3. **错误路径与空输入必须有专项用例**。happy path 绿不算绿：
   - 每个聚合/解析函数：空数组、缺字段、非法枚举值、错误状态载荷
   - 禁止在错误处理里硬编码吞状态（如 `final` 事件一律当成功）
4. **跨模块对接面用契约测试**：生产者真实产出 → 消费者直接消费（不经手写构造的中间数据）。事件类型、payload 字段、ID 约定都在契约测试里锁死。
5. **Mock 收窄**：只 mock 进程/网络边界（IPC、DB、fetch），业务逻辑用真实实现。mock 越厚，测试离生产越远。

## 案例摘要

- mock 的 `process.send` 是不读 this 的普通函数 → 裸调用 bug 全绿漏网（P0-1）
- event-buffer 测试只断言「收到 batch」没断言 id 唯一 → 占位 id `buffered` 让 renderer 去重误杀全部实时内容（P0-5）
- aggregator 把 `final{status:'failed'}` 硬编码为 done → 失败流错误文本永远不可见（P0-3）
- renderer 等 `dispatch_start` 事件，但生产链路从不产生它（实际是 `tool_call_start(isDispatch)`）→ 契约测试会在第一时间红（P0-6）

## 回归锁标准写法

```
1. 先写测试 → 确认红（复现 bug）
2. 用真实语义的 mock（this/唯一 id/时序）
3. 修复 → 绿
4. 断言覆盖：正常值 + 错误值 + 边界空值
```
