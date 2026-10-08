---
name: 前端最佳实践
description: React/前端实现的质量规则（重渲染/组件设计/bundle）。写 React 组件、页面或做前端性能优化时使用。
version: 1.0.0
---

# 前端最佳实践

## 适用场景

- React 组件设计与实现自检

## 工作流（实现前选型）

1. 组合优于配置：宁可 <Card><CardHeader/></Card> 组合，不造布尔弹球（title/actions/collapsed/onToggle 全塞 props）
2. 状态放使用处：状态提升仅在两个以上兄弟消费时做；跨页才上全局 store
3. 派生不存储：能从 props/state 算出的不再存 useState
4. 渲染性能：列表 key 稳定（不用 index）；昂贵子树 memo；context 拆分避免全树重渲染
5. 依赖与 bundle：大型库动态 import；图片懒加载；tree-shaking 不友好的包换具名 import 路径

## 输出规范

- 组件文件 ≤250 行；超过先拆

## 硬规则

- NEVER: useEffect 里做可以从渲染期推导的计算；prop drilling 超过 3 层不换方案
- ALWAYS: 上 useCallback/useMemo 前先问"测量过吗"——不过度优化，先正确
