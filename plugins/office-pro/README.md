# office-pro

office 文档生成代码工坊插件：在 Momo Studio 的 run_js 沙箱里执行 agent 生成的 Node.js 脚本，产出 pptx / xlsx / docx / pdf 文档。

## 能力

- **run_js 沙箱执行**：agent 生成文档生成代码，插件在受控环境执行并把产物落盘到工作区
- **office-authoring 方法论（skill）**：教 agent 怎么写「能跑对」的文档生成代码（布局 / 样式 / 校验节奏）
- **文档工程师预置（agent）**：开箱即用的文档生成 agent 定义
- **momo-validate 结构校验**：`validateOfficeFile(abs)` 对产物做 zip 完整性 + 关键部件存在性 + XML 良构粗检，供 agent 收工自查（「agent 自查」而非 schema 级校验，不保证 PowerPoint 语义合法）

## 目录结构

```
plugins/office-pro/
├── momo-plugin.json          # 插件清单（id / 版本 / 组件入口）
├── tools/                 # 插件工具（run_js 等，M3+）
├── bootstrap/             # 沙箱引导脚本（M3+）
├── skills/office-authoring/  # office 编写方法论 skill（M4+）
├── agents/                # 文档工程师 agent 定义（M4+）
├── vendor/
│   ├── package.json       # 运行库依赖清单
│   ├── momo-libs/         # 插件自有 JS 库（纯 CJS）
│   │   └── momo-validate/ # 结构校验库（本插件已可用）
│   └── node_modules/      # 构建产物（git 忽略，npm install 生成）
└── scripts/build.sh       # vendor 构建脚本
```

## 安装

- **dev（源码仓库内）**：插件随仓库放置于 `plugins/office-pro/`，App 启动时扫描加载。首次使用前先跑一次构建（见下节）。
- **打包分发**：构建产物随 App 打包安装；用户侧无需再执行 npm install（vendor/node_modules 已随包就绪）。

## 构建

```bash
bash plugins/office-pro/scripts/build.sh
```

脚本在 `vendor/` 下执行 `npm install --omit=dev`，产出 `vendor/node_modules/`（联网一次）。内网环境替代方案：`npm --offline --cache <预置缓存目录>`，或先 `npm config set registry <私服>`。

momo-libs 为插件自有代码（纯 CJS，随 git 提交），无需构建——运行期 `require('adm-zip')` 从 vendor/node_modules 解析，测试期由 electron workspace 依赖解析。

## Windows 安全基线

Windows 平台无 OS 级命令沙箱（macOS Seatbelt / Linux bubblewrap 均不可用），降级为 PowerShell plain 执行。office-pro 对此的补偿基线：

- **bootstrap fs 守卫**：脚本执行前注入文件系统守卫，限制写入目标只能是工作区产物目录，阻断路径逃逸（`..` / 绝对路径外写）
- **对齐 bash 策略**：出站网络与 bash 工具共用同一双态策略（允许 / 拒绝），默认拒绝
- **产物自查**：所有文档产物经 momo-validate 校验后才向 agent 返回成功，损坏/越权写入在收工时暴露
