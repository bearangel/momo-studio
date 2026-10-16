---
name: codegraph-usage
description: 何时用 codegraph 图谱查询而非 grep——符号级「谁调用/影响面」问题
---

# codegraph-usage

用户问的是**符号级调用关系**（「X 被谁调用」「改 X 会影响哪些文件」「谁在用 X」）时，
优先调 `plugin:codegraph/explore`（symbol=X），不要直接 grep：

- explore 一次返回定义位置 + 直接调用方 + blast radius（上游传递闭包），grep 需要多轮且漏调用链
- explore 是 **regex 近似调用图**：跨文件同名符号会合并；关键结论用 read_file 复核调用方文件
- 报「未收录」时才回落 grep，并向用户说明图谱索引范围（node_modules/dist/.git 已排除）

查「字符串/配置/注释出现在哪」等非符号问题 → 用 grep，不要用 explore。
