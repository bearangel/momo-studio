// electron/src/main/resource/ipc.handlers.ts
//
// 资源库 IPC handler 注册。20 个 resource 通道 + 1 个 misc 通道：
//   - resource:list         统一列表（filter 可选）
//   - resource:getDetail    按 id 查详情
//   - resource:install      marketplace 资源安装（封装现有 installPackage）
//   - resource:delete       统一删除/卸载（按 source+type 路由到底层删除函数）
//   - resource:registerMcp  注册自定义 MCP（P3 收敛自 mcp:register，返回 ResourceItem）
//   - resource:uploadSkill  上传自定义 skill zip（P3 收敛自 skill:uploadZip）
//   - resource:createSkill  表单创建 skill（spec 2026-09-22 资源库重设计）
//   - resource:scanGitRepoSkills / resource:importGitRepoSkills  Git 仓库
//     skill 导入两通道（P2.6 spec 2026-09-24 §4——scan 下载+解析落 tmp 返回
//     importId+清单；import 一次性消费返回 imported/failures 逐条结果）
import { emitPluginEvent } from '../plugin/event-sources';
//   - resource:registryProviders / resource:registryList  网络注册表（P2 双轨 hub，
//     spec 2026-09-22 §4.1——renderer 经此二通道消费 hub，不直连外网）
//   - resource:installSmitheryRemote  smithery needsConfig 二段安装（P2.1 Task 3）
//   - resource:parseMcpBundle / resource:importMcpBundle  DXT/MCPB 本地包两阶段
//     导入（P2.1 Task 5——parse 预览不落盘，import 重解包替换注册）
//   - resource:getMcpConfig / resource:updateMcpConfig / resource:danglingMcpRefs
//     MCP 配置编辑与悬空引用扫描（P2.2 Task 6——spec §4.1/§4.2/§4.3；业务逻辑
//     在 resource/mcp-config.ts，本层只做入参防御与透传）
//   - resource:getMcpEditView / resource:updateMcpEntry  MCP 全字段编辑
//     （P2.5 Task 2——spec §3.1-3.3；stdio + 远程通吃，custom 源专用入口；
//     UPDATE 保 id/source/installed_at，业务逻辑在 resource/mcp-config.ts）
//   - resource:listBuiltinPresets  预置清单只读（P2.3 spec §5——本地 YAML 直读零网络）
//   - misc:openExternal     外链转系统浏览器（P2.3 spec §6——misc 命名空间首个
//     通道，无独立 misc 注册点，归属此文件，后续 misc:* 在此追加）
//
// 设计原则：
//   - list / getDetail 直接转发给 library（纯查询，无副作用）
//   - install 支持 marketplace / hub（smithery）双源（builtin 不可装、
//     custom 已在本地）；hub 未装条目经 id 反解直装，不经 library（两态返回：
//     needsConfig=true 时带 schema 给 renderer 弹窗，不注册）
//   - delete 按 source + type 路由：marketplace→uninstallPackage / custom 三分支 /
//     builtin 抛错。各底层删除函数的参数语义不同，详见各分支注释。
//     custom+mcp 先查 bundle 记账行（P2.1 Task 5：DXT/MCPB 条目走 bundle 卸载，
//     同步清理解包目录与记账行）。
//   - registerMcp / uploadSkill 是注册表写入口，语义归 resource 域：registerMcp
//     落库 source='custom' 后复用 library 的 custom 映射取回 ResourceItem 返回。
//     （modelscope hub 轨已于 P2.1 移除，P3 若公开 API 落地再评估）
//
// P4 Task 4 追加：三个 custom 写通道成功后 fire-and-forget 广播资源目录
//

import { randomUUID } from 'node:crypto';
import { ipcMain, shell, app } from 'electron';
import { logger } from '../logger';
import { listResources, resolveResourceById } from './library';
import { listMarketplaceResources } from './marketplace';
import {
  parseResourceId,
  sourceLabel,
  type ResourceFilter,
  type ResourceItem,
  type ResourceType,
} from './types';
import {
  fetchSmitheryDetail,
  installSmitheryRemote,
  uninstallHubMcp,
  installHubPackage,
  uninstallHubPackage,
  type SmitheryInstallResult,
} from './hub-install';
import {
  getMcpConfigView,
  updateRemoteMcpConfig,
  listDanglingMcpRefs,
  getMcpEditView,
  updateMcpEntry,
  setMcpEnabled,
  type McpConfigUpdateInput,
  type McpEntryUpdateInput,
} from './mcp-config';
import { HUB_PROVIDERS } from './hub';
import { isSmitheryDegraded } from './hub/smithery';
import { getHubCatalogOwnership, isHubCatalogDegraded, isHubNotEnrolled } from './hub/momo-hub';
import { scanHubCoexistIssues } from './hub/ownership';
import { installPackage, uninstallPackage } from '../marketplace/installer';
import { fetchCatalog, isCatalogDegraded } from '../marketplace/client';
import { deleteRegistered, registerMcpDefinition } from '../mcp/host-manager';
import {
  parseMcpBundle,
  importMcpBundle,
  uninstallMcpBundle,
  isBundleInstalled,
  type BundlePreview,
} from '../mcp/bundle-import';
import { deleteCustomSkill, uploadSkillZip } from '../skill/zip-uploader';
import { createSkillFromForm, type SkillCreateInput } from '../skill/form-create';
import { importGitRepoSkills, scanGitRepoSkills } from '../skill/git-import';
import { deleteDefinition, removeMcpRefsFromAgents } from '../agent/crud';
import { broadcastSessionListChanged } from '../im/session-service';
import { listBuiltinPresetAgents, previewBuiltinPresetAgent } from '../agent/builtin';
import { getActiveWorkspaceId } from '../workspace/ipc.handlers';
import { toUserFacingError } from '../util/user-facing-error';

/** resource:registerMcp 入参——注册自定义 MCP 的最小配置（id / version 由主进程补全） */
export interface RegisterMcpInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 可选版本号；缺省存 '1.0.0'（DB 列 version NOT NULL） */
  version?: string;
  /** 传输形态；缺省 'stdio'。远程条目传 'streamable_http' + url（P2 Task 7 二态透传） */
  transport?: 'stdio' | 'streamable_http';
  /** 远程端点（transport='streamable_http' 必填，http/https 均可，http 供自建/本地测试；remote 时 command 空串占位） */
  url?: string;
  /** P2.4：远程条目请求头（含鉴权 key，沿用不落日志纪律） */
  headers?: Record<string, string>;
  /** P2.4：stdio 条目子进程工作目录；缺省不传（与 bundle 导入 spawn 同语义） */
  cwd?: string;
}

/**
 * smithery 条目安装两态判定（P2.1 Task 3）：拉详情 → deploymentUrl 校验 →
 * required 非空返回 needsConfig（不注册——Task 6 弹窗收集后走
 * resource:installSmitheryRemote 二段通道）；否则直装。
 */
async function installSmitheryEntry(slug: string): Promise<SmitheryInstallResult> {
  const detail = await fetchSmitheryDetail(slug);
  // detail.connections 可能缺失（响应形状退化），防御读取后由下方「!conn?.deploymentUrl」
  // 分支自然落到中文「暂不可直连」错误，避免对 renderer 抛不可读的英文 TypeError
  const conn = Array.isArray(detail.connections) ? detail.connections[0] : undefined;
  const deploymentUrl = conn?.deploymentUrl;
  if (!deploymentUrl || !deploymentUrl.startsWith('https://')) {
    throw new Error('该服务器暂不可直连（可能需要 Smithery 托管 OAuth）');
  }
  const schema = conn?.configSchema;
  if (schema?.required?.length) {
    return { needsConfig: true, schema };
  }
  await installSmitheryRemote(slug, deploymentUrl, {}, schema);
  return { needsConfig: false };
}

/**
 * MCP 配置编辑两通道的入参防御：name 须非空字符串（IPC 序列化缺参/空串兜底，
 * 防止空名落进 service 层查库后抛出不可读的「未注册」误报）。
 */
function assertMcpName(name: string): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('MCP 名不能为空');
  }
}

/** hub 安装上下文（plugin 链消费：minAppVersion 闸 + enablement 作用域——
 *  与 plugin:installZip 的取值口径一致：renderer 显式传 ws 缺省取活动工作区） */
function hubInstallContext(): { appVersion: string; workspaceId?: string } {
  return { appVersion: app.getVersion(), workspaceId: getActiveWorkspaceId() ?? undefined };
}

/**
 * 注册 resource:* 命名空间的 IPC handler。
 * 在 app ready 后由 registerIpcHandlers（ipc/index.ts）统一调用。
 */
export function registerResourceHandlers(): void {
  // resource:list — 统一资源列表，filter 可选（按 type/source 过滤）
  ipcMain.handle('resource:list', async (_evt, filter?: ResourceFilter) => {
    return listResources(filter);
  });

  // resource:getDetail — 按 id 查单个资源详情，找不到返回 null
  ipcMain.handle('resource:getDetail', async (_evt, id: string) => {
    return resolveResourceById(id);
  });

  // resource:install — marketplace 安装（P4 Task 5）+ hub 安装（P2.1 Task 3 / M1 Task 10）
  // marketplace：installPackage 底层需要完整的 MarketplaceItem（含 downloadUrl/checksum 等），
  // ResourceItem 不携带这些字段，故先 fetchCatalog 按 slug 找到原 catalog item 再传入。
  // smithery：详情 deploymentUrl 直连（两态返回——needsConfig 见
  // installSmitheryEntry；renderer types.d.ts 的 SmitheryInstallResult 有镜像）。
  // hub（momo-hub 第五源）：目录项 → MarketplaceItem → installPackage 全链
  // （installHubPackage 内 fresh 查目录取 latest + 已装 semver 判定——target ≤
  // 已装返回 alreadyLatest 如实回执，M2.3 T2；返回形状透传 renderer）。
  const __resourceInstall = async (_evt: unknown, id: string): Promise<unknown> => {
    const item = await resolveResourceById(id);
    if (!item) {
      // hub（smithery）未安装条目不在 library——library 只映射已装行。
      // 注册表「安装」按钮的主路径：id 反解三元组直接进 hub 安装链
      const hubParsed = parseResourceId(id);
      if (hubParsed?.type === 'mcp' && hubParsed.source === 'smithery') {
        return installSmitheryEntry(hubParsed.slug);
      }
      // momo-hub 条目：hub 离线/降级时目录拉不到、library 里查不到——
      // 仍按 id 反解三元组进安装链（installHubPackage 内部查目录，失败给人话错误）。
      // plugin 自 T12 起同链安装（plugin 域注册链 + 记账）
      if (hubParsed?.source === 'hub') {
        return installHubPackage(hubParsed.type, hubParsed.slug, hubInstallContext());
      }
      // marketplace 条目：library-store-split 起 listResources 收窄为本地实体，
      // 未装条目查不到——获取弹窗「安装」按 id 反解进安装链（catalog 按 slug+type
      // 反查原 MarketplaceItem，与下方已装分支同口径）
      if (hubParsed?.source === 'marketplace') {
        const catalog = await fetchCatalog();
        const catalogItem = catalog.items.find(
          (ci) => ci.slug === hubParsed.slug && ci.type === hubParsed.type && ci.downloadUrl,
        );
        if (!catalogItem) {
          throw new Error(`marketplace catalog 中未找到 slug=${hubParsed.slug}`);
        }
        return installPackage(catalogItem);
      }
      throw new Error(`资源 ${id} 不存在`);
    }
    // hub 分支前置于 installable 守卫（D6「更新」死路）：已装 hub 项 installable
    // 恒 false（fromCatalogItem / 兜底行口径），但更新语义 = 同 slug 重装目录新
    // 版本（cache 按 version 分目录 + installed_packages upsert，T10 语义），
    // renderer 更新按钮与安装按钮同走 resource:install——守卫不得拦截。
    // marketplace / smithery 已装重装仍由下方守卫拦（既有保护不动）。
    if (item.source === 'hub') {
      return installHubPackage(item.type, item.slug, hubInstallContext());
    }
    if (!item.installable) throw new Error(`「${item.name}」不可安装`);

    if (item.source !== 'marketplace') {
      throw new Error(`source=${item.source} 不支持 install 操作`);
    }
    // 注：已装 smithery 条目不在此分支——listHubInstalledResources 恒置
    // installable=false，上方「不可安装」守卫先抛，无需重复处理
    // fetchCatalog 拿到完整 catalog，按 slug 找到原 MarketplaceItem
    const catalog = await fetchCatalog();
    const catalogItem = catalog.items.find((ci) => ci.slug === item.slug);
    if (!catalogItem) {
      throw new Error(`marketplace catalog 中未找到 slug=${item.slug}`);
    }
    return installPackage(catalogItem);
  };
  ipcMain.handle('resource:install', async (evt: unknown, id: string): Promise<unknown> => {
    try {
      const __r = await __resourceInstall(evt, id);
      emitPluginEvent('resourceInstalled', { id });
      return __r;
    } catch (err) {
      // M2.4 D1：hub 安装/更新失败上行前剥掉错误类名前缀（HubCatalogStaleError: …）
      // 与 Electron 包装（防御幂等）——renderer 通知只留人话；未知错误原文照传。
      throw toUserFacingError(err);
    }
  });

  // resource:installSmitheryRemote — smithery needsConfig 二段安装（P2.1 Task 3）。
  // 反解 id → 重拉详情（schema 真源——不信任 renderer 回传，防漂移）→
  // 带用户配置直装（x-from 分流在 installSmitheryRemote 内完成）。
  ipcMain.handle(
    'resource:installSmitheryRemote',
    async (_evt, id: string, config: Record<string, string>) => {
      const parsed = parseResourceId(id);
      if (!parsed || parsed.source !== 'smithery' || parsed.type !== 'mcp') {
        throw new Error(`非 smithery MCP 资源：${id}`);
      }
      const detail = await fetchSmitheryDetail(parsed.slug);
      // 同 installSmitheryEntry：防御响应缺 connections 字段，避免英文 TypeError 上抛
      const conn = Array.isArray(detail.connections) ? detail.connections[0] : undefined;
      const deploymentUrl = conn?.deploymentUrl;
      if (!deploymentUrl || !deploymentUrl.startsWith('https://')) {
        throw new Error('该服务器暂不可直连（可能需要 Smithery 托管 OAuth）');
      }
      await installSmitheryRemote(parsed.slug, deploymentUrl, config, conn?.configSchema);
    },
  );

  // resource:delete — 按 source + type 路由到底层删除函数
  //   - builtin        → 抛错（系统预置不可移除）
  //   - marketplace    → uninstallPackage(catalogItem.id)（按 installed_packages.item_id 查删）
  //   - custom + mcp   → deleteRegistered(item.slug)（按 mcp_definitions.name 查删）
  //   - custom + skill → deleteCustomSkill(item.slug)（按 skills 目录名查删）
  //   - custom + agent → deleteDefinition(item.slug)（按 agent_definitions.slug 查删）
  //   - smithery       → uninstallHubMcp（mcp 行 + installed_packages 记账同删）
  const __resourceDelete = async (_evt: unknown, id: string): Promise<unknown> => {
    const item = await resolveResourceById(id);
    if (!item) throw new Error(`资源 ${id} 不存在`);
    if (!item.removable) {
      // 错误文案须含 "系统预置不可移除" 连续子串（builtin 场景），用 sourceLabel 拼接保证一致
      throw new Error(`${sourceLabel(item.source)}不可移除：「${item.name}」`);
    }
    // hub 分支须在 switch 之前：source 联合已扩 smithery，但 switch
    // default 会拒——hub 行直接删（deleteRegistered 只拦 marketplace）
    if (item.source === 'smithery') {
      uninstallHubMcp(item.source, item.slug);
      return;
    }
    switch (item.source) {
      case 'marketplace': {
        // 警告：uninstallPackage 按 installed_packages.item_id + item_type 查删——
        // item_id 列存的是 catalog 的 MarketplaceItem.id（opaque），不是
        // ResourceItem.id。直接传 item.id 会查无此行 → 静默 no-op（用户以为删成功
        // 但实际没删）。须 fetchCatalog 按 slug 反查 catalog 原 id 与 type。
        const catalog = await fetchCatalog();
        const catalogItem = catalog.items.find((ci) => ci.slug === item.slug);
        if (!catalogItem) {
          throw new Error(`marketplace catalog 中未找到 slug=${item.slug}（可能 catalog 已变更）`);
        }
        return uninstallPackage(catalogItem.id, catalogItem.type);
      }
      case 'hub': {
        // hub 记账 item_id = `hub:{slug}`（hubPackageItemId 单点前缀）——同款陷阱：
        // 传 ResourceItem.id 会查无此行 → 静默 no-op。type 从当前资源上下文透传
        //（T15a-F1：同 slug 跨类型记账碰撞时按类型路由，不碰运气）
        return uninstallHubPackage(item.type, item.slug);
      }
      case 'custom': {
        let deleted: unknown;
        if (item.type === 'mcp') {
          // P2.1 Task 5：先查 bundle 记账行——DXT/MCPB 导入条目走 bundle 卸载
          //（删 mcp 行 + 清理解包目录 + 删记账行），否则维持原单行删除
          if (isBundleInstalled(item.slug)) {
            uninstallMcpBundle(item.slug);
          } else {
            deleted = deleteRegistered(item.slug);
            // P2.2 Task 5：删行成功后级联清理 agent 侧引用（bundle 条目的级联
            // 在 uninstallMcpBundle 内部，此处只挂直删断面，防双重级联）
            const cleaned = removeMcpRefsFromAgents(item.slug);
            if (cleaned.length > 0) {
              logger.info('卸载级联清理 MCP 引用', { name: item.slug, agents: cleaned });
            }
          }
        } else if (item.type === 'skill') deleted = deleteCustomSkill(item.slug);
        else if (item.type === 'agent') {
          deleted = deleteDefinition(item.slug);
          // 级联可能清空会话成员（FK CASCADE）→ 通知 renderer 刷新会话列表
          broadcastSessionListChanged();
        }
        else throw new Error(`未知 custom type: ${item.type}`);
        // 统一等待删除成功再广播（失败上抛时不广播旧目录）
        await deleted;
        return deleted;
      }
      default:
        throw new Error(`source=${item.source} 不支持 delete 操作`);
    }
  };
  ipcMain.handle('resource:delete', async (evt: unknown, id: string): Promise<unknown> => {
    const __d = await __resourceDelete(evt, id);
    emitPluginEvent('resourceRemoved', { id });
    return __d;
  });

  // resource:registerMcp — 注册自定义 MCP 并返回其 ResourceItem。
  // id / version 由主进程补全（renderer 不再关心持久化细节），source 固定 'custom'
  // （保证 resource:delete 的 custom 分支可删）。注册后走 library 的 custom 映射
  // （listResources filter 短路，不触发 fetchCatalog）按 name 取回条目返回。
  ipcMain.handle('resource:registerMcp', async (_evt, config: RegisterMcpInput) => {
    registerMcpDefinition({
      id: randomUUID(),
      name: config.name,
      version: config.version ?? '1.0.0',
      // 二态透传（P2 Task 7）：remote（streamable_http+url）由 registerMcpDefinition
      // 校验 https 并给 command 兜底空串（DB 列 NOT NULL）；stdio 缺省不受影响
      transport: config.transport,
      url: config.url,
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      // P2.4：headers/cwd 透传（落库端 registerMcpDefinition 本就支持）
      headers: config.headers,
      cwd: config.cwd,
      source: 'custom',
    });
    const items: ResourceItem[] = await listResources({ type: 'mcp', source: 'custom' });
    const item = items.find((i) => i.slug === config.name);
    if (!item) {
      throw new Error(`注册后未在自定义资源中找到 MCP ${config.name}`);
    }
    // custom 资源变更 → 广播资源目录（fire-and-forget）
    return item;
  });

  // resource:uploadSkill — 上传自定义 skill zip，返回 UploadedSkill[]（v1.6.2 起支持批量）。
  // renderer 经 preload 用 Uint8Array 传输（contextBridge 里 Node Buffer 跨 IPC
  // structured clone 会损坏），main 收到后转回 Buffer。
  ipcMain.handle(
    'resource:uploadSkill',
    async (_evt, data: Uint8Array | Buffer, filename: string) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const uploaded = uploadSkillZip(buffer, filename);
      // skill 虽不入 P2P 目录（2.1 排除），仍统一触发广播保持 custom 写通道行为一致
      return uploaded;
    },
  );

  // resource:createSkill — 表单创建 skill（spec 2026-09-22 资源库重设计，唯一新通道）。
  // 写 <skillsDir>/<slug>/SKILL.md + .sha256 标记（listInstalled 自动识别 custom 源）；
  // slug 冲突覆盖（与 zip 重复上传同语义——UI 提交前自行比对提示）。
  ipcMain.handle('resource:createSkill', async (_evt, input: SkillCreateInput) => {
    const uploaded = createSkillFromForm(input);
    return uploaded;
  });

  // P2.6：Git 仓库 skill 导入第一阶段——scan 下载 zip 归档落 tmp 并解析出全部
  // skill 清单（spec 2026-09-24 §4）。只读预览（不落正式目录）→ 不广播；
  // importId 是第二阶段的消费凭证（一次性）。
  ipcMain.handle('resource:scanGitRepoSkills', async (_evt, url: string) =>
    scanGitRepoSkills(url),
  );

  // P2.6：第二阶段——按 importId 一次性消费 tmp，逐 skill 幂等/覆盖落盘，返回
  // { imported, failures }（单条失败不中断）。await 之后才广播：失败 reject 时
  // 不广播旧目录（与 registerMcp/uploadSkill 同语义）。
  ipcMain.handle('resource:importGitRepoSkills', async (_evt, importId: string) => {
    const result = await importGitRepoSkills(importId);
    return result;
  });

  // resource:parseMcpBundle — DXT/MCPB 本地包两阶段导入的第一阶段（P2.1 Task 5）。
  // 解包校验 + manifest 解析 + user_config 形状判定，不落正式目录。renderer 持有
  // 原文件 buffer，第二阶段（importMcpBundle）重解包——主进程零中间状态。
  // Uint8Array → Buffer 同 uploadSkill 模式（contextBridge 里 Node Buffer 跨 IPC
  // structured clone 会损坏）。
  ipcMain.handle(
    'resource:parseMcpBundle',
    async (_evt, data: Uint8Array | Buffer, filename: string): Promise<BundlePreview> => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      return parseMcpBundle(buffer, filename);
    },
  );

  // resource:importMcpBundle — 第二阶段：变量替换 + S1 校验 + cwd 注册 + 记账，
  // 返回 custom ResourceItem（Task 6 弹窗提交表单后调用）。
  ipcMain.handle(
    'resource:importMcpBundle',
    async (
      _evt,
      data: Uint8Array | Buffer,
      filename: string,
      userConfig: Record<string, string>,
    ) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const item = importMcpBundle(buffer, filename, userConfig);
      return item;
    },
  );

  // resource:registryProviders — 网络获取模式 provider 元信息（含可达性，spec §4.1）。
  // builtin 恒可用（本地 catalog，零网络）；hub degraded 取各自退避状态——不打网络，
  // 退避窗口内即视为不可达，窗口过期后首次 list 才真探测。
  ipcMain.handle('resource:registryProviders', async () => {
    const hubs = HUB_PROVIDERS.map((p) => ({
      key: p.key,
      label: p.label,
      region: p.region,
      types: [...p.types],
      // 新增 provider 默认视为可达（false），接入退避后再挂各自探测函数
      degraded:
        p.key === 'smithery' ? isSmitheryDegraded() : p.key === 'hub' ? isHubCatalogDegraded() : false,
    }));
    return [
      {
        key: 'builtin',
        label: '内置市场',
        region: 'local' as const,
        types: ['agent', 'mcp', 'skill'] as const,
        degraded: false,
      },
      ...hubs,
    ];
  });

  // resource:registryList — 按 provider 拉取注册表条目（library-store-split 起
  // 获取弹窗三源的唯一浏览通道）。builtin（=网络市场 catalog 快照）分支直连
  // listMarketplaceResources（resource:list 已收窄为本地实体，不经其取目录）+
  // 客户端过滤（name/description/slug 模糊）排序（未安装在前、已装垫底）——
  // 本地全量目录无服务端分页，page 参数忽略、hasMore 恒 false；hub/smithery
  // 分支委托对应 provider（query / page / opts 透传，各自带退避负缓存，失败
  // 返回 degraded 不抛错；opts.fresh 供 hub 弹窗「刷新」入口走 loadFresh）。
  ipcMain.handle(
    'resource:registryList',
    async (
      _evt,
      providerKey: string,
      type: ResourceType,
      query?: string,
      page?: number,
      opts?: { fresh?: boolean },
    ) => {
      if (providerKey === 'builtin') {
        const catalog = await fetchCatalog();
        const items = listMarketplaceResources(catalog).filter((i) => i.type === type);
        const q = query?.trim().toLowerCase();
        const matched = q
          ? items.filter(
              (i) =>
                i.name.toLowerCase().includes(q) ||
                i.description.toLowerCase().includes(q) ||
                i.slug.toLowerCase().includes(q),
            )
          : items;
        return {
          entries: matched
            .slice()
            .sort((a, b) => Number(a.installed) - Number(b.installed))
            .map((item) => ({
              id: item.id,
              type: item.type,
              name: item.name,
              description: item.description,
              version: item.version,
              tags: item.marketplace?.tags ?? [],
              category: item.marketplace?.category,
              item,
            })),
          degraded: false,
          hasMore: false,
          total: items.length,
        };
      }
      const provider = HUB_PROVIDERS.find((p) => p.key === providerKey);
      if (!provider) throw new Error(`未知 registry provider: ${providerKey}`);
      return provider.list(type, query, page, opts);
    },
  );

  // resource:getMcpConfig — 查看已装远程 MCP 配置（P2.2 Task 6，spec §4.1）。
  // 三级 schema 降级与 values 回显在 mcp-config.getMcpConfigView 内完成；
  // bare=true 时返回体无 schema 键（renderer 镜像 schema?: 与此同形）。
  ipcMain.handle(
    'resource:getMcpConfig',
    async (_evt, name: string) => {
      assertMcpName(name);
      return getMcpConfigView(name);
    },
  );

  // resource:updateMcpConfig — 编辑已装远程 MCP 配置（P2.2 Task 6，spec §4.2）。
  // 校验（存在 / streamable_http / https）与 x-from 重组在 updateRemoteMcpConfig 内；
  // headers 仅裸模式整包覆盖、schema 可选透传落库——IPC 层不判模式，形状随 input。
  ipcMain.handle(
    'resource:updateMcpConfig',
    async (_evt, name: string, input: McpConfigUpdateInput) => {
      assertMcpName(name);
      await updateRemoteMcpConfig(name, input);
    },
  );

  // P2.5 Task 2：MCP 全字段编辑（stdio + 远程；custom 源专用入口，spec §3.3）。
  // view 供编辑弹窗预填全字段；update 走 mcp-config.updateMcpEntry（专用 UPDATE
  // 保 id/source/installed_at + 池驱逐 + 目录广播），async 包裹让 getMcpEditView
  // 的同步抛错在 IPC 侧统一为 rejected promise。
  ipcMain.handle(
    'resource:getMcpEditView',
    async (_evt, name: string) => {
      assertMcpName(name);
      return getMcpEditView(name);
    },
  );

  ipcMain.handle(
    'resource:updateMcpEntry',
    async (_evt, name: string, input: McpEntryUpdateInput) => {
      assertMcpName(name);
      await updateMcpEntry(name, input);
    },
  );

  // 组⑤：MCP 启停（写库 + 禁用时驱逐池内运行实例；业务在 mcp-config.setMcpEnabled）
  ipcMain.handle(
    'resource:setMcpEnabled',
    async (_evt, name: string, enabled: boolean) => {
      assertMcpName(name);
      await setMcpEnabled(name, enabled);
    },
  );

  // resource:danglingMcpRefs — 悬空 MCP 引用扫描（P2.2 Task 6，spec §4.3）。
  // 扫描异常在 listDanglingMcpRefs 内降级空数组（卡片静默不显示，spec §7）。
  ipcMain.handle('resource:danglingMcpRefs', async () => {
    return listDanglingMcpRefs();
  });

  // resource:getCatalogStatus — 远程目录降级态（走查 D9）。renderer 资源库据此
  // 显示「网络目录暂时不可达」提示条，区分「离线降级」与「目录为空」。
  // sources 逐源聚合（M1c）：marketplace 远程目录 + momo-hub 目录各自的降级态。
  // hubNotEnrolled（M2.5 终审 FIX-1）：hub 未接入是「无目录」而非「目录为空」，
  // renderer 播种门控必须据此拒绝把兜底记账行当成「已是最新」的目录证据。
  ipcMain.handle('resource:getCatalogStatus', () => ({
    degraded: isCatalogDegraded(),
    hubNotEnrolled: isHubNotEnrolled(),
    sources: [
      { source: 'marketplace' as const, degraded: isCatalogDegraded() },
      { source: 'hub' as const, degraded: isHubCatalogDegraded() },
    ],
  }));

  // resource:hubCatalogOwnership — hub 目录归属快照（M5.0 §7.1/§7.3/§7.4）：
  // 徽标/发布钮/下架钮归属收敛的判定输入。走目录源 load()（TTL/lastGood 语义
  // ——不可达时归属滞留合理，spec §7.1 明言）。
  ipcMain.handle('resource:hubCatalogOwnership', () => getHubCatalogOwnership());

  // resource:hubCoexistScan — 存量并存扫描（M5.0 §7.5 清理小票）：hub 装记账 ×
  // 本地 custom 实体同 slug 并存清单。一次扫描非阻断，设置页 hub 面板消费。
  ipcMain.handle('resource:hubCoexistScan', () => scanHubCoexistIssues());

  // resource:listBuiltinPresets — 预置清单只读（P2.3 spec §5）。本地直读
  // resources/agents/*.yaml（agent/builtin.ts 现有解析链），零网络——刻意不走
  // fetchCatalog（其远程优先语义违背零网络红线）。当前预置仅 agent 有「启用」
  // 管线（preset.ts），mcp/skill 无预置语义 → 固定返回空数组。
  ipcMain.handle('resource:listBuiltinPresets', async (_evt, type: ResourceType) => {
    if (type !== 'agent' && type !== 'mcp' && type !== 'skill') {
      throw new Error(`资源类型非法: ${String(type)}`);
    }
    return type === 'agent' ? listBuiltinPresetAgents() : [];
  });

  // resource:previewBuiltinPreset — 单个预置 agent 能力预览（2026-10-08 预设可见化 +
  // 薄 fork）。只读不落库，数据恒为 YAML 最新版；坏/空 slug 由 previewBuiltinPresetAgent
  // 内 readBuiltinManifestBySlug 抛中文错（renderer 详情面板红字）。
  ipcMain.handle('resource:previewBuiltinPreset', async (_evt, slug: string) => {
    if (typeof slug !== 'string' || slug === '') {
      throw new Error('预置 slug 不能为空');
    }
    return previewBuiltinPresetAgent(slug);
  });

  // misc:openExternal — 外链转系统浏览器（P2.3 spec §6）。显式 https 校验
  // （区别于 window.ts setWindowOpenHandler 的无条件转发——那是被动安全闸，
  // 本通道是 renderer 主动调用的受控入口）；空串 / 非 https 一律中文拒绝，
  // 不触碰系统浏览器。
  ipcMain.handle('misc:openExternal', async (_evt, url: string) => {
    if (typeof url !== 'string' || url === '') {
      throw new Error('链接不能为空');
    }
    if (!url.startsWith('https://')) {
      throw new Error('仅支持打开 https:// 开头的链接');
    }
    await shell.openExternal(url);
  });

  logger.info('Resource IPC handlers 已注册');
}
