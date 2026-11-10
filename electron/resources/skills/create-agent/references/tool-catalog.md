# 内置工具速查表

给 agent 授工具（manifest `defaultTools`）前先在此查真实工具名——只授任务必需的。
数据以当时工具注册中心（`tools:getCatalog`）为准；资源创建六工具（`resource_list` / `create_agent` / `add_agent_member` / `create_skill` / `create_mcp` / `create_team`）的用法见各自技能册，不在本表展开。

## 文件读写

- read_file：读工作区内文本文件（Read-before-Edit 守门依据）
- write_file：写文件（全量覆盖，落变更账本可撤销）
- list_files：列出目录与文件清单
- edit_file：精确字符串替换编辑（须先读过该文件）
- mkdir：创建目录
- rm：删除文件/目录（不可恢复，默认不启用）
- mv：移动/重命名
- exists：检查文件或目录是否存在
- apply_patch：V4A 风格多文件原子补丁（结构化批量修改）

## 搜索

- grep：工作区正则内容搜索
- glob：文件名模式匹配找文件

## 终端与进程

- bash：工作区内自由 shell（OS 沙箱内执行，出站网络受策略管控）
- process_list：列出本回合 bash 启动的后台进程组及存活成员
- process_keep：把本回合启动的服务标记为用户保留（跨回合存活，上限每工作空间 5 个）
- process_kill：终止本回合启动的后台进程（整组击杀）

## Git

- git_repos：列出 workspace 内可发现的 git 仓库（唯一 -C 入口依据）
- git_status：查看仓库状态（porcelain 格式）
- git_diff：查看 diff（默认含 staged 与 unstaged）
- git_log：提交历史（oneline 格式）
- git_show：单个 commit 详情（message + diff）
- git_add：暂存文件
- git_commit：提交（受 GitPolicy message pattern 管控）
- git_branch：列出/创建分支（双语义）
- git_checkout：切换分支（仅切分支）
- git_stash：stash 管理（push/list/pop/drop）

## 网页与浏览器

- webfetch：抓取 URL 并转为 markdown 文本
- browser_navigate：内嵌浏览器打开 URL
- browser_snapshot：页面可交互元素快照（a11y 树，附 uid）
- browser_screenshot：页面截图
- browser_click：按 uid 点击元素
- browser_type：向元素输入文本
- browser_press_key：按键或组合键
- browser_hover：悬停元素
- browser_scroll：滚动页面
- browser_evaluate：在页面内执行 JS
- browser_console_messages：读取控制台消息
- browser_tabs：标签页管理
- browser_close：关闭页面

## 任务与记忆与 Office

- todowrite：全量替换任务清单（source=user 是本轮授权依据）
- list_delegation_targets：列出可指派的委派目标（create_task 前必查真实 ID）
- create_task：创建任务（本机指派或跨节点路由二选一）
- read_task：读任务详情与执行历史摘要
- read_task_history：读任务执行室 IM 消息历史
- read_task_progress：读任务执行进度流（message_events 全量）
- complete_task：完成任务
- fail_task：标记任务失败
- list_tasks：列出任务
- list_task_groups：列看板泳道分组（与工作组不同域）
- list_workgroups：列 hub 工作组（跨节点协作域）
- memory_save：保存长期记忆（rule/preference 常驻注入）
- memory_search：BM25 全文检索三层记忆
- memory_get：按 id 读记忆全文
- memory_forget：删除过时记忆（用户记忆不可删）
- office_read：读 xlsx/docx/pptx/pdf 结构化文本
- office_read_cells：Excel 精读（sheet + A1 range 取精确单元格）
- office_copy：复制办公文档副本
- list_sessions：列出当前 workspace 的会话
- read_session：读取另一会话的消息内容
