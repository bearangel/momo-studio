# Email 插件本地邮件库（加密归档）设计

- 日期：2026-11-05
- 状态：待评审（评审通过后进入实施计划）
- 关联：`2026-11-05-email-plugin-design.md`（插件总体设计）、`2026-10-15-plugin-system-design.md`（面板协议与信任模型）
- 适用仓库：`momo-plugin`（插件实现）、`momo-studio`（面板协议小改动）

## 1. 背景与目标

当前 email 插件只把**信封索引**（标题/发件人/日期/uid）与**草稿登记**存在本地 SQLite，正文与附件每次读信都从 IMAP 重新拉取。由此产生两个问题：

1. 缓存过期后切换文件夹/账号会**同步等待远端**，体感慢；
2. 无法离线阅读已读邮件，正文与附件不落地。

本设计引入**按需本地邮件库**：用户指定一个存储根目录，插件把读过的邮件原文（RFC 822）加密落盘，SQLite 只保存路径索引。

### 1.1 已确认裁定（用户逐项确认）

| 决策 | 结论 |
|---|---|
| 首要目标 | **按需缓存**：打开过的邮件才落盘；不做全量同步 |
| 根目录粒度 | **全局一份**（所有账号共用），插件自动建账号子目录 |
| 路径选择入口 | **平台新增 `app:pickDirectory` 面板桥**，调用系统目录选择器 |
| 加密密钥 | **主密钥存系统钥匙串**（`ctx.secrets`），无口令解锁 |
| 文件粒度 | **每封一个加密 `.eml.enc`**（RFC 822 原文整体加密） |
| 保留策略 | **与信封缓存同一策略**（账号 `retention`，Sent 永久） |
| 单封上限 | **>25MB 不落盘**（仍可在线读） |
| 删除账号 | 二次确认后**一并删除该账号本地库** |
| 路径存放 | 插件自有 `dataDir/settings.json`，不进平台插件 config schema |

## 2. 现状事实（实现依据）

- 插件 service 运行在 Electron 主进程，经 `createRequire` 原生加载，无 fs 沙箱；数据目录为 `<userData>/plugins/data/email/`
- 现有 `data.db`（`node:sqlite`）schema `user_version=2`：`drafts` / `envelope_cache` / `envelope_cache_meta` / `folder_cache`
- 读信用 `mailbox.read()`：IMAP `fetchSource` → mailparser 解析，内存 LRU 50 条
- 保留策略已实现于 `mailbox.js`：`retentionCutoff()` + `filterByAge()`，Sent 永久、sent 探测失败不清理
- 面板为 `sandbox="allow-scripts"` iframe，经 `PanelChannel` 五消息协议通信；入站白名单仅 `ready / app:getContext / app:subscribe / plugin:callService`（`renderer/src/lib/plugin/panel-channel.ts`）
- 宿主已有 `dialog:pickDirectory` IPC（`electron/src/main/ipc/dialog.handlers.ts`、preload `window.api.dialog.pickDirectory`），但面板白名单未放行
- 面板消息限制：单条 ≤256KB、20 条/秒、三振断开

## 3. 总体架构

```
                    panel (iframe)
                        │  app:pickDirectory（新增白名单）
                        ▼
              PanelHost ──► dialog:pickDirectory（既有）
                        │
                   callService 路由（既有）
                        ▼
            email service（主进程）
     ┌───────────────┬──────────────┬───────────────┐
     │ mailbox       │ archive      │ store(data.db)│
     │ IMAP 取原文   │ 加解密/读写  │ 索引/草稿/信封│
     └───────────────┴──────┬───────┴───────────────┘
                            ▼
                 <用户根目录>/<accountId>/...
```

职责边界：

- `archive`：只负责「按 (accountId, folder, uid) 存取加密原文」与保留清理；不理解 IMAP
- `store`：只存索引行与既有表；不持有文件句柄
- `mailbox`：读信先问 archive，未命中再走 IMAP 并回填；对外行为不变
- `crypto`：纯函数加解密，无 IO

## 4. 存储布局

```
<rootPath>/
  <accountId>/
    <folder 逐段 encodeURIComponent>/
      <YYYY-MM>/
        <uid>-<sha256 前 8 位>.eml.enc
```

- 路径段消毒：拒绝 `..`、反斜杠、空段（与现有 envelope 缓存同名规则一致）；`accountId` 与 `folder` 均逐段编码
- `YYYY-MM` 取邮件 `date`（解析失败回退落盘时间，UTC）
- 原子写：写入同目录 `.tmp-<pid>-<rand>` → `fsync` 可选 → `rename`
- 索引存**相对路径**；根目录切换不破坏旧索引语义（见 §8）

## 5. 索引（`data.db` schema v3）

`PRAGMA user_version` 2 → 3，仅新增表（研发期无历史数据迁移）。版本占用：**v2 = folder_cache（列表 SWR）；v3 = local_archive（归档）**。

```sql
CREATE TABLE IF NOT EXISTS local_archive (
  account_id  TEXT NOT NULL,
  folder      TEXT NOT NULL,
  uid         INTEGER NOT NULL,
  root_id     TEXT NOT NULL,          -- settings.json 中的当前/历史根目录标识
  rel_path    TEXT NOT NULL,          -- 相对 rootPath
  size_bytes  INTEGER NOT NULL,       -- 加密文件大小
  sha256      TEXT NOT NULL,          -- 原文哈希（用于完整性核对/去重二期）
  enc_version INTEGER NOT NULL,       -- 当前 1
  msg_date    INTEGER NOT NULL DEFAULT 0,  -- 邮件时间（ms），0=未知
  state       TEXT NOT NULL,          -- ok | missing | corrupt | too_large
  cached_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_local_archive_root ON local_archive(root_id);
```

- `state='too_large'`：只记状态不存文件（用于 UI 统计与避免重复尝试）
- `root_id` 与当前设置不一致的行视为**未命中**（不删除，供手动清理）
- 启动时执行一次轻量核对：`state='ok'` 但文件不存在 → 置 `missing`（不阻塞启动）

## 6. 加密

### 6.1 密钥

- 首次启用归档时生成 32 字节随机主密钥：`crypto.randomBytes(32)`
- 存放：`ctx.secrets.set('archive:master-key', base64)`（与账号密码同一 keychain 通道）
- 读取失败/不存在 → 禁用归档并提示「本地邮件库未初始化」，不影响收信

### 6.2 文件格式

```
offset  size   field
0       7      magic "MOMAIL1"
7       1      enc_version (1)
8       12     iv (随机)
20      16     auth tag
36      N      ciphertext (RFC822 原文)
```

- 算法：AES-256-GCM
- AAD：`accountId|folder|uid|enc_version`（UTF-8）——防文件互换与版本降级
- 解密失败（tag 校验不过/截断/魔数不符）→ `state='corrupt'` + 删除文件 + 回退 IMAP

### 6.3 安全边界

- 元数据（标题/发件人/日期）仍明文存在 `envelope_cache`（本设计非目标：元数据加密）
- 主密钥丢失 = 本地邮件不可恢复；设置页固定文案提示
- 根目录内文件为密文，直接拷贝无法阅读（但可被整体拷贝）

## 7. 读路径与写路径

### 7.1 读信（`mails.get` → `mailbox.read`）

```
read(accountId, folder, uid):
  1. 内存 LRU 命中 → 返回
  2. archive.read(...) 命中且解密成功 → mailparser 解析 → 写 LRU → 返回（不触网）
  3. 未命中/缺失/corrupt/too_large → 现有 IMAP fetchSource → 解析 → 返回
  4. 异步：归档启用时——原文 ≤25MB → `archive.write`（失败仅 warn，不影响本次返回）；原文 >25MB → 仅写索引 `state='too_large'`（不落盘）
```

### 7.2 附件（`attachments.get`）

- 先尝试本地归档（解密 → 解析 → 取 part）；未命中走 IMAP 并顺带落盘整封
- 附件不单独落盘（一期）

### 7.3 写路径

```
archive.write(accountId, folder, uid, raw, msgDate):
  if (!settings.archive.enabled || !rootWritable) return
  if (raw.length > 25MB) → 索引 state='too_large'，return
  rel = buildRelPath(...)
  原子写密文 → sha256 = hash(raw)
  upsert 索引行（state='ok'）
```

- 写文件失败：不写索引（避免假成功），仅 warn
- 索引写失败而文件已落：留孤儿文件，启动核对时按「无索引文件」清理（见 §9）

## 8. 设置与根目录切换

`dataDir/settings.json`：

```json
{
  "archive": {
    "enabled": true,
    "rootId": "uuid",
    "rootPath": "/Users/xxx/MomoMail"
  }
}
```

- 设置 `rootPath` 时生成新的 `rootId`
- 切换根目录：旧文件**不自动搬移/删除**，旧 `root_id` 的索引行自然失效（读不到 → 按需重下）；UI 提示「旧目录数据仍在，可手动清理」
- 清除本地库：删除当前 rootId 下索引行与文件；旧 rootId 留待用户手动处理

## 9. 保留清理与自愈

- 复用 `retentionCutoff()`：`retention='forever'` 或 Sent 文件夹 → 不清理
- 触发时机：service `start()` 一次；每次归档写入后按账号节流（≥10 分钟一次）；账号 retention 变更后立即一次
- 清理：按 `msg_date`（0 视为未知，不清理）删除文件与索引行；文件删除失败 → 置 `missing`
- 自愈：
  - 索引有、文件无 → `missing`，读时重下
  - 文件有、索引无（或 root 不一致）→ 启动核对时删除孤儿文件（仅限当前 rootId 的账号目录）

## 10. 配置与管理（2026-11-05 再裁定：全部在 设置 → 插件）

**配置面（平台插件 config，Settings → 插件 → 邮件）**：

- `archiveRoot`（`type: path`，标题「本地邮件存储目录」）：设置页系统目录选择器（`dialog:pickDirectory`）；**留空 = 默认目录 `~/.momo-plugin/email`**（首启自动创建，开箱即归档）
- `showRemoteImages`（`type: boolean`，默认关）：开 → 面板邮件默认放行远程图片（面板按钮为会话级覆盖）
- 配置保存后平台自动重启 service → `start()` 对账：路径与当前不同 → `archive.setRoot`（换 rootId，旧库保留）；目录不可用 → warn 降级在线读信
- **面板无存储入口**（首版曾有「存储…」弹层，随配置迁移一并移除）；面板仅启动读 `config.get`

### 10.1 服务路由

- `archive.getSettings` → `stats()`：`{ enabled, rootPath, rootId, files, bytes, missing, corrupt, tooLarge }`
- `archive.setRoot` → `{ path }`：校验绝对路径、`realpath` 后存在且为目录、可写、非文件系统根（拒绝 `/`、`C:\`）——现由 service 启动对账内部调用
- `archive.clear` → 清当前 rootId 的文件与索引行（返回删除计数；**仅清当前 `rootId`**，历史根目录需手动清理）
- `config.get` → `{ showRemoteImages, archiveRoot }`（非敏感配置透出给面板/工具）

## 11. 平台桥 `app:pickDirectory`

- `PanelChannel.INBOUND_TYPES` 增加 `app:pickDirectory`
- `PanelHostHandlers` 增加 `pickDirectory(opts)`；`PanelHost` 实现转调 `window.api.dialog.pickDirectory`
- 入站处理：解析 `{title?}` → 返回 `{ path: string | null }`；异常按 rpc error 回包
- 安全：
  - 同一面板**并发仅 1 次**目录选择（进行中再次请求直接拒绝），避免模态对话框刷屏
  - 仅返回路径字符串，不授予任何 fs 能力
  - 既有令牌桶/三振限流继续生效
- 平台测试：白名单接受/拒绝、并发拒绝、错误回包、PanelHost 转发

## 12. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 根目录不存在/不可写 | 设置页红字；归档禁用，收发与在线读信不受影响 |
| 主密钥缺失 | 归档禁用 + 提示重新初始化（旧文件不可解） |
| 单封 >25MB | 不落盘，标记 `too_large`，在线读 |
| 解密失败 | 删文件 + `corrupt` + 重下 |
| 磁盘满 | 写失败仅 warn；索引不更新 |
| 账号删除 | 二次确认后删除该账号目录 + 索引行 |
| 面板选择器被取消 | 保持原路径不变 |

## 13. 测试锚点

**插件侧（vitest）**

- `crypto.test.ts`：round-trip；AAD 篡改失败；错误密钥失败；截断/魔数错误
- `archive.test.ts`：写→读；>25MB 不落盘；原子写（tmp 不残留）；rel_path 消毒（`..`/反斜杠/空段拒绝）；root 切换后旧行不命中
- `store.test.ts`：schema v3 升级（v2→v3 仅建表）；索引状态机；聚合统计
- `mailbox.test.ts`：命中本地不触发 IMAP；缺失回退并补写；corrupt 自愈；Sent 不清理
- `service-index.test.ts`：`archive.setRoot/clear/stats` 路由；非法路径拒绝
- `panel-static.test.ts`：存储区元素与 `app:pickDirectory` 调用锚点

**平台侧**

- `panel-channel.test.ts`（**新建**——该模块当前无测试）：新增消息白名单；并发拒绝；未授权消息仍断开
- `PanelHost.test.tsx`：转发 `dialog.pickDirectory` 与错误回包

**真机验收（QQ/Sina）**

1. 配置根目录 → 打开邮件 → 目录出现 `<uid>-*.eml.enc`，文件为密文
2. 断开网络 → 重开同一封 → 正常显示（本地解密）
3. 手动删除该文件 → 重开 → 自动从 IMAP 重下并重建文件
4. 账号 retention=1m → 注入旧 `msg_date` → 清理后文件与索引行消失；Sent 不受影响
5. 切换根目录 → 旧文件保留、新读邮件落到新目录

## 14. 非目标（一期不做）

- 全量/后台同步、离线全文搜索
- 附件单独落盘与内容寻址去重
- 索引元数据加密（标题等仍明文）
- 用户口令加密/多设备密钥同步
- 根目录自动迁移（只提示，不搬文件）

## 15. 实施拆分（供 writing-plans）

1. 平台桥：`app:pickDirectory`（panel-channel 白名单 + PanelHost handler + 测试）
2. `crypto.js` + `archive.js`（含 settings.json 与 root_id）
3. `store` schema v3：`local_archive` 表 + 聚合/状态方法
4. 读路径接入：`mailbox.read` / `attachments.get` 本地优先 + 异步回填
5. 保留清理与自愈（启动核对、孤儿清理）
6. 面板存储区 UI + 路由（setRoot/clear/stats）
7. 文档：`2026-11-05-email-plugin-design.md` 增补存储章节与 §5.1 链接

## 16. 风险

- `node:sqlite` 与 Electron/Node 升级（既有风险，继续监控）
- 主密钥丢失不可恢复（已在 UI 明示）
- 大附件邮件解密解析耗时（>25MB 不落盘策略缓解；解析已有 2MB 读信上限）
- 根目录放在同步盘（iCloud/OneDrive）可能产生冲突文件（文档提示，不强制拦截）
