# 预设 Agent 与 Skill 内容库实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为五类目标用户（需求/UI/全栈/管理/办公）落地 5 个 agent（1 新增 + 4 升级）+ 20 个 builtin skill（17 新增 + 3 规范化升级）+ catalog 双轨登记对齐。

**Architecture:** 纯内容预设——SKILL.md 目录（`electron/resources/skills/`，目录即 builtin 已装）+ agent YAML（`electron/resources/agents/`，预置库按需启用）+ catalog 条目（`resources/marketplace/catalog.json`，builtin 内联展示层）。零 TS 机制改动，唯一代码面是一致性契约锁测试与既有测试计数联动。

**Tech Stack:** YAML manifest（K8s 风格 AgentDefinition）/ Markdown SKILL.md（frontmatter name/description/version）/ catalog.json / vitest（electron workspace）

**Spec:** `docs/specs/2026-10-08-preset-agents-skills-design.md`（本计划从 spec 出发，执行者需同时读 spec 与本计划）

## Global Constraints

- 容器内先 `nvm use 20`（Node 26 破坏 better-sqlite3 native binding）；命令统一 `npx pnpm@9.0.0 ...`
- TypeScript strict：任何文件禁 `any` / `@ts-ignore` / `as any`（含测试）
- 所有内容与注释中文；slug/标识符英文小写 kebab-case
- **不动三处 package.json 版本号**（研发期版本纪律，`docs/dev/release.md`）
- Conventional Commits：`feat:` / `test:` / `docs:`
- 单测位置：electron 主进程集中 `electron/tests/`（镜像 src 结构）
- catalog agent 条目的 `readme` 是 systemPrompt 载体——升级 agent 时 readme 必须与新 prompt 关键词同步；office-assistant 既有契约锁（`electron/tests/agent/tools/office/builtin-office.test.ts`：add_chart / SUMIF / fill / 第一 / office_read_cells / set_format / 白名单 / 百分比 / 50 行 / IF|COUNTIF|SUMIF / office_fill_ppt_template / 模板 / 填充）必须始终全绿
- `electron/tests/marketplace/client.test.ts:95` 硬编码本地 catalog 条目总数——每个改动条目数的任务同步更新该断言（终态 `toBe(26)`）

## Review Focus

1. **catalog ↔ skills 目录漂移回归**（未来加 skill 忘登记 catalog，或反之）→ Task 1 测试 A 双向相等锁死
2. **agent defaultSkills 引用不存在的 slug** → 运行时技能静默不挂载、无报错 → Task 1 测试 B 逐 agent 断言
3. **SKILL.md description 无触发短语** → 渐进披露 Layer 1 永不匹配、loadSkill 永不触发 → Task 1 测试 C（长度下限）+ 各内容任务的具体触发短语文案（每个 description 必须含「用户提到 X 时使用」式短语）
4. **agent YAML 解析失败被启动流程静默跳过**（registerBuiltinAgents 坏文件只记日志）→ Task 1 测试 D 逐文件用生产解析器断言
5. **office-assistant 的 readme / systemPrompt / 工具 description 三处关键词漂移** → Task 7 收尾复跑 builtin-office.test.ts 全量验证
6. **ui-designer 的 defaultTools 引用不存在的工具名**（新 YAML 无 office 那样的专项锁）→ Task 1 测试 E 对全部 agent 的工具引用逐一断言

---

## File Structure

**新增：**
- `electron/tests/skill/preset-consistency.test.ts` — 一致性契约锁（A/B/C/D 四测）
- `electron/resources/skills/<slug>/SKILL.md` × 17 + `references/*.md` × 4（frontend-polish / design-critique / tech-design-review / excel-analysis 各一个）
- `electron/resources/agents/ui-designer.yaml` — UI 设计师 agent

**覆盖升级：**
- `electron/resources/skills/{code-review,write-tests,debug-reproduce}/SKILL.md` — 结构规范化
- `electron/resources/agents/{requirement-analyst,coder,pm-agent,office-assistant}.yaml` — 四段式 prompt + defaultSkills + version 1.1.0

**修改：**
- `resources/marketplace/catalog.json` — 漂移修复 + 25 条新增/更新条目 + updatedAt
- `electron/tests/marketplace/client.test.ts:95` — 条目计数联动
- `CHANGELOG.md` — 研发账本条目

---

### Task 1: 一致性契约锁 + catalog 漂移修复

**Files:**
- Create: `electron/tests/skill/preset-consistency.test.ts`
- Modify: `resources/marketplace/catalog.json`
- Modify: `electron/tests/marketplace/client.test.ts:86-97`

**Interfaces:**
- Consumes: `parseFrontmatter`（`electron/src/main/skill/zip-uploader.ts` 导出）、`parseAgentManifestWithSuggestion`（`electron/src/main/agent/manifest-parser.ts` 导出）、`ALL_BUILTIN_TOOLS`（`electron/src/main/agent/tools/catalog.ts` 导出，builtin-office.test.ts 同款导入）
- Produces: 五个契约测试（A catalog 对齐 / B defaultSkills 引用 / C frontmatter 完整 / D manifest 可解析 / E defaultTools 工具名真实）——后续所有任务以此测试保持绿为完成标准

- [ ] **Step 1: 写契约锁测试（先红）**

创建 `electron/tests/skill/preset-consistency.test.ts`：

```typescript
// electron/tests/skill/preset-consistency.test.ts
// 预设内容库一致性契约锁（spec 2026-10-08 §8）：
//   A. catalog builtin skill 条目 ≡ skills 目录（双轨同步，防漂移回归）
//   B. agent YAML defaultSkills 引用的 slug 全部真实存在（防运行时静默丢技能）
//   C. 全部 SKILL.md frontmatter 完整（name/description 非空且足以承载触发语）
//   D. 全部 agent YAML 可被生产解析器解析（防启动流程静默跳过坏文件）
//   E. agent defaultTools 引用的工具名全部真实存在（防工具契约漂移，同 builtin-office 先例）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../../src/main/skill/zip-uploader';
import { parseAgentManifestWithSuggestion } from '../../src/main/agent/manifest-parser';
import { ALL_BUILTIN_TOOLS } from '../../src/main/agent/tools/catalog';

// __dirname = electron/tests/skill（3 级上溯到仓库根）
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'electron', 'resources', 'skills');
const AGENTS_DIR = path.join(REPO_ROOT, 'electron', 'resources', 'agents');
const CATALOG_PATH = path.join(REPO_ROOT, 'resources', 'marketplace', 'catalog.json');

function listSkillSlugs(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listAgentYamls(): string[] {
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.yaml')).sort();
}

interface CatalogShape {
  items: Array<{ type: string; slug: string; downloadUrl: string }>;
}

function readCatalog(): CatalogShape {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as CatalogShape;
}

describe('预设内容库一致性（spec 2026-10-08）', () => {
  it('A. catalog builtin skill 条目与 skills 目录一一对齐（防双轨漂移）', () => {
    const catalogSkillSlugs = readCatalog().items
      .filter((i) => i.type === 'skill' && i.downloadUrl === '')
      .map((i) => i.slug)
      .sort();
    expect(catalogSkillSlugs).toEqual(listSkillSlugs());
  });

  it('B. agent YAML 的 defaultSkills 引用全部存在于 skills 目录', () => {
    const slugs = new Set(listSkillSlugs());
    for (const f of listAgentYamls()) {
      const { def } = parseAgentManifestWithSuggestion(
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8'),
      );
      for (const ref of def.defaultSkills) {
        expect(slugs.has(ref.ref), `${f} 引用了不存在的 skill: ${ref.ref}`).toBe(true);
      }
    }
  });

  it('C. 全部 SKILL.md frontmatter 完整（name/description 非空，description ≥ 12 字）', () => {
    for (const slug of listSkillSlugs()) {
      const md = fs.readFileSync(path.join(SKILLS_DIR, slug, 'SKILL.md'), 'utf-8');
      const front = parseFrontmatter(md);
      expect(front.name, `${slug} 缺 name`).toBeTruthy();
      expect(front.description, `${slug} 缺 description`).toBeTruthy();
      expect(
        front.description!.length,
        `${slug} description 过短（应含触发场景短语）`,
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it('D. 全部 agent YAML 可被生产解析器解析（防静默跳过）', () => {
    for (const f of listAgentYamls()) {
      const { def } = parseAgentManifestWithSuggestion(
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8'),
      );
      expect(def.slug, f).toBeTruthy();
    }
  });

  it('E. agent YAML 的 defaultTools 引用的工具全部真实存在（防契约漂移）', () => {
    // LSP 休眠豁免：LSP 子系统 2026-10-08 下架（commit 9cc3407a，ALL_BUILTIN_TOOLS
    // 已摘除 lsp_*），现有 agent YAML 的 lsp 引用是下架提交刻意保留的休眠态；
    // LSP 恢复时移除本豁免。
    const dormantRefs = new Set(['lsp_diagnostics', 'lsp_find_references']);
    for (const f of listAgentYamls()) {
      const { def } = parseAgentManifestWithSuggestion(
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8'),
      );
      for (const t of def.defaultTools) {
        expect(
          ALL_BUILTIN_TOOLS.includes(t.ref) || dormantRefs.has(t.ref),
          `${f} 引用了不存在的工具: ${t.ref}`,
        ).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: 跑测试确认 A 红（漂移存在）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/preset-consistency.test.ts`
Expected: 测试 A FAIL（catalog skill 条目 `["code-review-workflow"]` ≠ 目录 `["code-review","debug-reproduce","write-tests"]`）；B/C/D PASS

- [ ] **Step 3: 修复 catalog 漂移**

修改 `resources/marketplace/catalog.json`：

把现有 `skill-code-review` 条目（slug 为 `code-review-workflow`）整体替换为以下三条（slug 与目录一一对齐；`code-review` 保留原 description 语义）：

```json
    {
      "id": "skill-code-review",
      "type": "skill",
      "slug": "code-review",
      "name": "代码审查",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "以缺陷预防为导向审查代码变更——先看控制流与边界，再提改进建议。",
      "readme": "# 代码审查\n\n结构化审查：正确性→并发→资源泄漏→错误处理→类型安全→可读性；每个发现附严重级别与修复建议。",
      "tags": ["code-review", "quality"],
      "category": "development",
      "iconEmoji": "🔍",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-write-tests",
      "type": "skill",
      "slug": "write-tests",
      "name": "编写测试",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "为指定模块补单元测试——先锁行为再写实现细节，错误路径必须有专项用例。",
      "readme": "# 编写测试\n\nmock 只收窄到进程/网络/DB 边界；覆盖矩阵=正常值+边界空值+错误路径；先写红再写绿。",
      "tags": ["testing", "quality"],
      "category": "development",
      "iconEmoji": "🧪",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-debug-reproduce",
      "type": "skill",
      "slug": "debug-reproduce",
      "name": "调试复现",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "修复 bug 前先建立可靠复现——最小复现、根因假设、逐个排除。",
      "readme": "# 调试复现\n\n最小复现→根因假设（≥2 个）→逐个排除→修复后固化为回归测试；禁止 shotgun debugging。",
      "tags": ["debugging", "quality"],
      "category": "development",
      "iconEmoji": "🐛",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
```

- [ ] **Step 4: 更新 client.test.ts 条目计数（6 → 8）**

`electron/tests/marketplace/client.test.ts` 两处：
- 第 86 行注释改为：`// 本地内置 catalog 含 8 个预填充 item（见 resources/marketplace/catalog.json）`
- 第 95 行 `expect(catalog.items.length).toBe(6);` → `expect(catalog.items.length).toBe(8);`

- [ ] **Step 5: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/preset-consistency.test.ts tests/marketplace/client.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add electron/tests/skill/preset-consistency.test.ts resources/marketplace/catalog.json electron/tests/marketplace/client.test.ts
git commit -m "test: 新增预设内容库一致性契约锁并修复 catalog skill 漂移"
```

---

### Task 2: 通用组 3 个 skill

**Files:**
- Create: `electron/resources/skills/doc-coauthoring/SKILL.md`
- Create: `electron/resources/skills/humanize-writing/SKILL.md`
- Create: `electron/resources/skills/verification-before-done/SKILL.md`
- Modify: `resources/marketplace/catalog.json`（追加 3 条 skill 条目）
- Modify: `electron/tests/marketplace/client.test.ts:95`（8 → 11）

**Interfaces:**
- Consumes: Task 1 的契约锁测试（保持绿）
- Produces: slug `doc-coauthoring` / `humanize-writing` / `verification-before-done`——Task 3（office-assistant 引用 doc-coauthoring、humanize-writing）与 Task 6（pm-agent 引用 verification-before-done）依赖

- [ ] **Step 1: 写 doc-coauthoring**

`electron/resources/skills/doc-coauthoring/SKILL.md`：

```markdown
---
name: 长文档共创
description: 与用户协作撰写长文档（方案、报告、手册、说明书）。用户要求"写一份文档/报告/方案"或需要多轮打磨长文本时使用。
version: 1.0.0
---

# 长文档共创

## 适用场景

- 从零共创或大幅改写超过 3 屏的长文档
- 不适用：单轮问答、短消息改写

## 工作流

1. 上下文转移：先问清（或从材料提取）文档目标读者、用途、篇幅、语气；有参考材料先 read_file 读完再动笔
2. 定骨架：先只产出目录级大纲（章节标题 + 每章一句话要点），交用户确认后再展开
3. 分节迭代：一次展开 1-2 节，每节写完即停，等用户反馈再继续；不要一次输出全文
4. 读者验证：全文完成后，以"目标读者第一次读"的视角通读，标记跳转断裂、术语不一致、重复表述并修复

## 输出规范

- Markdown；一级标题 = 文档名，二级 = 章节
- 产出到 workspace 文件（write_file），对话内只展示当前迭代节

## 硬规则

- NEVER: 未经确认就展开全部章节；编造用户没给过的数据、引文、案例
- ALWAYS: 每轮结束时说明"下一节计划写什么"，给用户打断的机会
```

- [ ] **Step 2: 写 humanize-writing**

`electron/resources/skills/humanize-writing/SKILL.md`：

```markdown
---
name: 反 AI 腔中文写作
description: 清除 AI 味套话，让中文文字像人写的。用户嫌文字"AI 味重/太机器/太正式"或产出对外沟通文案时使用。
version: 1.0.0
---

# 反 AI 腔中文写作

## 适用场景

- 周报、汇报、通知、对外文案等"要给人看"的文字
- 不适用：技术文档、代码注释等需要精确术语的场景

## 工作流

1. 识别套话：扫「综上所述 / 总而言之 / 值得注意的是 / 不难发现 / 随着…的发展 / 赋能 / 抓手 / 闭环」；用户行业术语保留
2. 删或改：套话直接删（多数情况句子更干净）；必须过渡就用人话改写
3. 拆长句：超过 40 字的句子拆成两句；连续排比改自然陈述
4. 具体化：把「大幅提升/显著改善」换成带数字或具体事实的表述；没有数据就删掉程度副词
5. 读一遍：改成"念出声通顺"的口语节奏

## 输出规范

- 保留用户原有结构（标题/列表不动），只改文字层

## 硬规则

- NEVER: 为了"像人"堆砌语气词（"嘛/啦/哈"）；把精确术语换成模糊口语
- ALWAYS: 信息密度只增不减——删套话不删信息
```

- [ ] **Step 3: 写 verification-before-done**

`electron/resources/skills/verification-before-done/SKILL.md`：

```markdown
---
name: 完成前验证
description: 声称"完成"之前先拿证据。任何任务收尾、提交交付物、汇报"已完成"时使用。
version: 1.0.0
---

# 完成前验证

## 适用场景

- 任何要向用户报告"做完了"的时刻
- 写代码后的自检、生成文件后的确认

## 工作流

1. 列声称：明确你即将声称"完成"的每一项（功能点/文件/修复）
2. 逐项取证：代码 → 跑测试或 lsp_diagnostics；文件 → exists + read_file 抽查内容；数据 → 重新读出比对
3. 证据入报：汇报里写明验证方式与结果（"测试 X 个全过"优于"应该没问题"）
4. 没证据的项：明说"未验证 + 原因 + 建议验证方式"，不降格为"基本完成"

## 硬规则

- NEVER: 用"应该/大概/理论上"修饰"已完成"；测试没跑就说测试通过
- ALWAYS: 汇报中的每个"完成"都能指出对应的验证证据
```

- [ ] **Step 4: catalog 追加 3 条 + 计数更新**

`resources/marketplace/catalog.json` items 末尾追加：

```json
    {
      "id": "skill-doc-coauthoring",
      "type": "skill",
      "slug": "doc-coauthoring",
      "name": "长文档共创",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "与用户协作撰写长文档：上下文转移→骨架确认→分节迭代→读者验证。",
      "readme": "# 长文档共创\n\n先定骨架再分节展开，每节等反馈；全文完成后以读者视角通读修复断裂与不一致。",
      "tags": ["writing", "collaboration"],
      "category": "general",
      "iconEmoji": "📄",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-humanize-writing",
      "type": "skill",
      "slug": "humanize-writing",
      "name": "反 AI 腔中文写作",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "清除 AI 味套话，让中文文字像人写的：删套话、拆长句、具体化。",
      "readme": "# 反 AI 腔中文写作\n\n识别并删除「综上所述/赋能/抓手」式套话；长句拆短；程度副词换具体事实；信息密度只增不减。",
      "tags": ["writing", "style"],
      "category": "general",
      "iconEmoji": "✍️",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-verification-before-done",
      "type": "skill",
      "slug": "verification-before-done",
      "name": "完成前验证",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "声称完成之前先拿证据：列声称→逐项取证→证据入报。",
      "readme": "# 完成前验证\n\n每个「完成」都要有验证证据；没证据的明说未验证，不降格为「基本完成」。",
      "tags": ["verification", "quality"],
      "category": "general",
      "iconEmoji": "✅",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    }
```

`electron/tests/marketplace/client.test.ts`：第 86 行注释 8 → 11；第 95 行 `toBe(8)` → `toBe(11)`。

- [ ] **Step 5: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/preset-consistency.test.ts tests/marketplace/client.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add electron/resources/skills/doc-coauthoring electron/resources/skills/humanize-writing electron/resources/skills/verification-before-done resources/marketplace/catalog.json electron/tests/marketplace/client.test.ts
git commit -m "feat: 新增通用组预设 skill（文档共创/反 AI 腔/完成前验证）"
```

---

### Task 3: 需求组 2 个 skill + requirement-analyst 升级

**Files:**
- Create: `electron/resources/skills/prd-coauthoring/SKILL.md`
- Create: `electron/resources/skills/user-story-craft/SKILL.md`
- Modify: `electron/resources/agents/requirement-analyst.yaml`（version/systemPrompt/defaultSkills/头注释；**defaultTools 段不动**）
- Modify: `resources/marketplace/catalog.json`（2 条 skill + 更新 agent-requirement-analyst 条目）
- Modify: `electron/tests/marketplace/client.test.ts:95`（11 → 13）

**Interfaces:**
- Produces: slug `prd-coauthoring` / `user-story-craft`；requirement-analyst def 的 defaultSkills = 上两者（Task 1 测试 B 依赖此一致）

- [ ] **Step 1: 写 prd-coauthoring**

`electron/resources/skills/prd-coauthoring/SKILL.md`：

```markdown
---
name: PRD 渐进共创
description: 与用户共创产品需求文档（PRD）。用户提到"需求文档/PRD/产品方案/功能设计"时使用。
version: 1.0.0
---

# PRD 渐进共创

## 适用场景

- 新功能/新产品的需求梳理与 PRD 产出
- 不适用：已有 PRD 的小改动（直接 edit_file 改）

## 工作流

1. 三维追问（每轮只问一个维度，不连环轰炸）：
   - 数据源：这个数从哪来？谁录入？多久更新？
   - 业务规则：谁可以操作？超限/越权怎么办？审批链是什么？
   - 异常路径：网络断了/数据缺失/并发冲突时展示什么？
2. 骨架确认：产出 PRD 目录（背景/目标/用户故事/功能需求/非功能需求/验收标准），用户确认后展开
3. 分节产出：一次一节；未确认项写 [TBD-原因]，绝不编造业务规则
4. 验收标准：每个功能点配 Given/When/Then 式验收条目
5. 收尾自检：全文扫一遍 [TBD]，汇总成"待确认清单"交用户

## 输出规范

- Markdown 写入 workspace 的 docs/ 目录
- 模板：# PRD：<名称> / ## 背景 / ## 目标 / ## 用户故事 / ## 功能需求 / ## 非功能需求 / ## 验收标准

## 硬规则

- NEVER: 替用户发明业务规则、审批流、数据口径；把 [TBD] 静默填成猜测值
- ALWAYS: 模糊点用追问澄清，一次一个问题
```

- [ ] **Step 2: 写 user-story-craft**

`electron/resources/skills/user-story-craft/SKILL.md`：

```markdown
---
name: 用户故事与验收标准
description: 把需求拆成合格的用户故事和验收标准（AC）。用户提到"用户故事/user story/验收标准/故事拆分"时使用。
version: 1.0.0
---

# 用户故事与验收标准

## 适用场景

- 需求进入开发前的拆解；大故事切小

## 工作流

1. 故事卡片格式：作为<角色>，我要<动作>，以便<价值>
2. INVEST 体检：独立/可协商/有价值/可估算/小/可测试——不达标就拆
3. 拆分手法：按步骤拆（下单→支付→发货）、按数据拆（先文本后图片）、按角色拆（买家版/卖家版）
4. AC 写法：Given <前置> When <操作> Then <结果>；覆盖主路径 + 至少 1 条异常路径
5. 规模红线：一个故事超过 3 人日 → 必须再拆

## 输出规范

- 列表：故事 + AC 编号（AC1/AC2…），可直接贴进任务系统

## 硬规则

- NEVER: 故事里塞实现方案（"用 Redis 缓存"不属于故事）；写无法验证的 AC（"体验流畅"）
- ALWAYS: 每条 AC 可由一个人独立判定通过/不通过
```

- [ ] **Step 3: 升级 requirement-analyst.yaml**

修改 `electron/resources/agents/requirement-analyst.yaml`——文件头注释替换为：

```yaml
# 需求分析师 — 需求澄清与 PRD 共创（四段式 prompt，spec 2026-10-08）。
# 预置库按需启用（builtin 注册链自 v1.1 起休眠）；YAML 与 catalog 双轨同 coder 先例。
```

`metadata.version: 1.0.0` → `1.1.0`；`spec.declarative.systemPrompt` 整块替换为：

```yaml
    systemPrompt: |
      你是需求澄清者——用追问消解模糊，用结构沉淀共识；你从不替用户发明业务规则。

      工作流：
      1. 倾听用户描述，识别核心诉求与模糊点
      2. 逐个澄清：一次只问一个问题，优先问影响范围最大的（数据源 / 业务规则 / 异常路径）
      3. 骨架确认后分节产出需求文档（按已挂载技能的方法执行：prd-coauthoring / user-story-craft）
      4. 未确认项写 [TBD-原因]，收尾汇总成待确认清单交用户
      5. 文档用 write_file 写入 workspace 的 docs/ 目录

      工具要点：
      - 有参考材料先 read_file 读完再动笔
      - 已挂载技能（loadSkill）匹配任务时先加载再执行

      硬规则：
      - NEVER: 编造业务规则、审批链、数据口径；把 [TBD] 静默填猜测值
      - ALWAYS: 模糊先问后写；文档结构：# 需求文档：<项目名> / ## 背景 / ## 核心需求 / ## 功能列表 / ## 非功能需求 / ## 验收标准
```

`spec.type: sub` 与 `spec.parentAgentId: pm-agent` 保留不动；`defaultTools` 段保留不动。在 `defaultTools` 段之后（与之平级）追加：

```yaml
  defaultSkills:
    - kind: skill
      ref: prd-coauthoring
    - kind: skill
      ref: user-story-craft
```

- [ ] **Step 4: catalog 更新 + 计数**

`resources/marketplace/catalog.json` items 末尾追加 2 条 skill 条目：

```json
    {
      "id": "skill-prd-coauthoring",
      "type": "skill",
      "slug": "prd-coauthoring",
      "name": "PRD 渐进共创",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "与用户共创 PRD：三维追问→骨架确认→分节产出→[TBD] 占位纪律→验收标准。",
      "readme": "# PRD 渐进共创\n\n数据源/业务规则/异常路径三维追问；未确认项写 [TBD]；每功能点配 Given/When/Then 验收条目。",
      "tags": ["prd", "requirement"],
      "category": "product",
      "iconEmoji": "📋",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-user-story-craft",
      "type": "skill",
      "slug": "user-story-craft",
      "name": "用户故事与验收标准",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "把需求拆成 INVEST 合格的用户故事与可判定的验收标准。",
      "readme": "# 用户故事与验收标准\n\n作为<角色>我要<动作>以便<价值>；INVEST 体检；AC 用 Given/When/Then 覆盖主路径+异常路径。",
      "tags": ["user-story", "requirement"],
      "category": "product",
      "iconEmoji": "🎫",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    }
```

并把 `agent-requirement-analyst` 条目的 `version` 改 `1.1.0`，`description` 改为 `"帮用户澄清需求、渐进共创结构化 PRD 与用户故事。"`, `readme` 改为 `"# 需求分析师\n\n你是需求澄清者——用追问消解模糊，用结构沉淀共识。\n\n三维追问（数据源/业务规则/异常路径）→ 骨架确认 → 分节产出；未确认项写 [TBD]，从不替用户发明业务规则。"`。

`electron/tests/marketplace/client.test.ts`：注释 11 → 13；`toBe(11)` → `toBe(13)`。

- [ ] **Step 5: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/preset-consistency.test.ts tests/marketplace/client.test.ts tests/agent/builtin.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add electron/resources/skills/prd-coauthoring electron/resources/skills/user-story-craft electron/resources/agents/requirement-analyst.yaml resources/marketplace/catalog.json electron/tests/marketplace/client.test.ts
git commit -m "feat: 新增需求组预设 skill 并升级需求分析师 agent"
```

---

### Task 4: UI 设计组 3 个 skill + ui-designer agent

**Files:**
- Create: `electron/resources/skills/design-spec/SKILL.md`
- Create: `electron/resources/skills/frontend-polish/SKILL.md` + `references/anti-patterns.md`
- Create: `electron/resources/skills/design-critique/SKILL.md` + `references/checklist.md`
- Create: `electron/resources/agents/ui-designer.yaml`
- Modify: `resources/marketplace/catalog.json`（3 条 skill + 1 条 agent）
- Modify: `electron/tests/marketplace/client.test.ts:95`（13 → 17）

**Interfaces:**
- Produces: slug `design-spec` / `frontend-polish` / `design-critique`；`ui-designer` def（defaultSkills = 三者）

- [ ] **Step 1: 写 design-spec**

`electron/resources/skills/design-spec/SKILL.md`：

```markdown
---
name: 设计 spec 契约
description: 产出设计规范文档（DESIGN.md），作为设计与开发的交接契约。用户提到"设计规范/设计文档/组件 spec/设计交接"时使用。
version: 1.0.0
---

# 设计 spec 契约

## 适用场景

- 新页面/新组件动工前的设计定稿；设计与开发协作的中间契约

## 工作流

1. 发现：问清业务目标、目标用户、内容优先级；有品牌规范先读取
2. 设计 token：定义色板（主色/中性阶/功能色 5-7 个）、字体层级（3-4 档）、间距节奏（4/8 基数）、圆角与阴影档位
3. 组件 spec：逐组件写明用途/状态/尺寸变体
4. 布局与响应：关键断点下的布局变化
5. 交接文档：DESIGN.md 写入 workspace（write_file），供开发照此实现

## 输出规范

- DESIGN.md 结构：## 设计原则 / ## Design Tokens / ## 组件规范 / ## 布局与响应式 / ## 交付物清单

## 硬规则

- NEVER: token 出现规范外色值/字号；spec 与产出不一致还标"已完成"
- ALWAYS: 每个组件写全六状态（默认/悬停/激活/禁用/加载/错误）；颜色写字面值（#RRGGBB）不写"浅蓝"
```

- [ ] **Step 2: 写 frontend-polish + references**

`electron/resources/skills/frontend-polish/SKILL.md`：

```markdown
---
name: 前端审美规范
description: 杜绝 AI 味的界面设计准则。设计或实现 UI、用户嫌界面"模板味/廉价/不像人做的"时使用。
version: 1.0.0
---

# 前端审美规范

## 适用场景

- UI 视觉设计与前端实现自检

## 工作流

1. 排版层级：一屏一个视觉焦点；字号对比拉满（标题≈正文×1.6+）；行高 1.5-1.7
2. 间距节奏：用 4/8 的倍数；相关元素靠近、无关元素拉开——间距不一致是 AI 味头号来源
3. 色彩克制：主色 1 个 + 中性阶 + 功能色；灰阶不超过 5 档；禁止无意义的渐变和发光
4. 反模式自查：逐条过 references/anti-patterns.md（readResource 加载），命中即修
5. 细节收尾：对齐线检查、图标线宽统一、文字截断处理、空态/加载态设计

## 输出规范

- 设计产出走 design-spec 契约；实现自检逐条过反模式清单

## 硬规则

- NEVER: 装饰性渐变/阴影/动效（没有信息目的就删）；同一界面两种圆角/线宽体系
- ALWAYS: 动效有意义（反馈/引导）且时长克制（200ms 级）
```

`electron/resources/skills/frontend-polish/references/anti-patterns.md`：

```markdown
# 前端反 AI 味模式清单

逐条自查，命中任何一条即需修正：

## 布局
1. 三等分同权重卡片 + 全部相同 padding——信息本有主次，卡片却无
2. 所有元素垂直居中堆叠，没有对齐线变化
3. 间距只有一种（处处 16px），无节奏分组

## 色彩
4. 紫蓝渐变 hero + 居中大标题 +「开始使用」按钮
5. 无信息目的的渐变背景 / 发光边框
6. 灰阶超过 5 档且相邻档肉眼难辨
7. 功能色（成功/警告/错误）与品牌色混用不分

## 形状与图标
8. 到处圆角胶囊（按钮、卡片、标签全部 max 圆角）
9. emoji 当图标（🚀✨💡）——应使用统一图标库
10. 同一界面两种圆角体系 / 两种线宽

## 文字
11. 全大写英文标签滥用 + 宽字距
12. 标题与正文字号差距 < 1.3 倍（层级拉不开）
13. 长文案不做截断处理，容器被撑破

## 动效
14. 每个卡片都 hover 上浮 + 阴影
15. 无意义的入场动画（列表条目逐个淡入）
16. 动效超过 300ms 让人等

## 状态
17. 只有「有数据」状态——无空态 / 加载态 / 错误态设计
18. 加载用全屏 spinner 而非骨架屏
```

- [ ] **Step 3: 写 design-critique + references**

`electron/resources/skills/design-critique/SKILL.md`：

```markdown
---
name: 设计走查评审
description: 用清单评审界面截图。用户让"看看这个页面/评审设计/哪里不对劲"或界面实现完成后自检时使用。
version: 1.0.0
---

# 设计走查评审

## 适用场景

- 对已实现界面（浏览器截图）或设计稿的系统性走查

## 工作流

1. 取证：browser_navigate 打开页面 → browser_screenshot 全页截图；关键交互态补充截图（悬停/错误/空态）
2. 逐项走查：按 references/checklist.md 七大项（readResource 加载）——布局对齐 / 视觉层级 / 文字对比度 / 交互目标 / 状态完整性 / 键盘可达 / 品牌一致性
3. 分级输出：Blocker（不可用/看不清）/ Major（明显不规范）/ Polish（锦上添花）
4. 每条问题附：截图位置描述 + 期望行为 + 建议修法

## 输出规范

- 评审报告 Markdown：按分级分组，每条一段；结尾给 Top3 修复优先级

## 硬规则

- NEVER: 只说"感觉不错/整体还行"这种不可执行评语；评审没有截图证据的界面
- ALWAYS: 每条意见可被另一个人独立验证
```

`electron/resources/skills/design-critique/references/checklist.md`：

```markdown
# 设计走查清单

七大项逐项走查，每项产出 ✅/⚠️/❌ 与依据：

## 1. 布局与对齐
- 相邻元素是否共享对齐线；卡片间距是否遵循同一节奏（4/8 基数）
- 视觉焦点是否唯一；次要信息是否明确退后

## 2. 视觉层级
- 标题/正文/辅助文字字号对比是否足够（标题≥正文×1.6）
- 重要操作与危险操作的视觉权重是否区分

## 3. 文字
- 对比度：正文 ≥4.5:1，大字 ≥3:1（WCAG AA）
- 截断/换行处理；中英文混排间距；表格数字右对齐或等宽

## 4. 交互目标
- 可点区域 ≥ 32×32px（触屏 44×44）；可点与不可点视觉可辨

## 5. 状态完整性
- 六状态覆盖：默认/悬停/激活/禁用/加载/错误
- 空态有引导动作，不止插画

## 6. 键盘与可达
- 焦点可见；Tab 顺序合理；Esc/Enter 约定符合平台惯例
- 图标按钮有 aria-label 或可见文本

## 7. 品牌一致性
- 色值/圆角/线宽是否在 spec token 内；图标风格统一（同一库、同线宽）
```

- [ ] **Step 4: 新增 ui-designer.yaml**

创建 `electron/resources/agents/ui-designer.yaml`：

```yaml
# UI 设计师 — 设计规范与设计契约产出（四段式 prompt，spec 2026-10-08）。
# 单一 standalone（无子 agent）；预置库按需启用；YAML 与 catalog 双轨同 coder 先例。
apiVersion: v1
kind: AgentDefinition
metadata:
  name: UI 设计师
  slug: ui-designer
  version: 1.0.0
  description: 产出设计 token、组件 spec 与设计契约（DESIGN.md），并以截图走查评审界面。
  iconEmoji: "🎨"
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: |
      你是设计规范守护者——产出设计 token、组件 spec 与设计契约；你审查界面但不直接写产品代码。

      工作流：
      1. 理解需求：业务目标、目标用户、内容优先级；有品牌规范先读取
      2. 产出设计 spec（按 design-spec 技能的方法）：token → 组件 spec（六状态）→ 布局与响应式
      3. DESIGN.md 契约用 write_file 写入 workspace，作为开发实现依据
      4. 界面走查（按 design-critique 技能的清单）：browser_navigate 打开页面 → browser_screenshot 取证 → 分级输出评审意见
      5. 审美自检过 frontend-polish 反模式清单

      工具要点：
      - 走查用浏览器工具组取证，评审意见必须附截图证据
      - 设计产出（DESIGN.md / 评审报告）走 write_file

      硬规则：
      - NEVER: 未经走查证据就下界面评语；spec 出现规范外色值
      - ALWAYS: token 写字面值（#RRGGBB）；组件写全六状态（默认/悬停/激活/禁用/加载/错误）
    model:
      provider: anthropic
      model: claude-3-5-sonnet
  defaultTools:
    - kind: builtin
      ref: read_file
    - kind: builtin
      ref: write_file
    - kind: builtin
      ref: edit_file
    - kind: builtin
      ref: apply_patch
    - kind: builtin
      ref: mkdir
    - kind: builtin
      ref: mv
    - kind: builtin
      ref: exists
    - kind: builtin
      ref: grep
    - kind: builtin
      ref: glob
    - kind: builtin
      ref: browser_navigate
    - kind: builtin
      ref: browser_snapshot
    - kind: builtin
      ref: browser_screenshot
    - kind: builtin
      ref: browser_click
    - kind: builtin
      ref: browser_type
    - kind: builtin
      ref: browser_press_key
    - kind: builtin
      ref: browser_scroll
    - kind: builtin
      ref: browser_console_messages
    - kind: builtin
      ref: webfetch
    - kind: builtin
      ref: todowrite
    - kind: builtin
      ref: list_sessions
    - kind: builtin
      ref: read_session
    - kind: builtin
      ref: memory_search
    - kind: builtin
      ref: read_task
    - kind: builtin
      ref: read_task_history
    - kind: builtin
      ref: read_task_progress
    - kind: builtin
      ref: list_tasks
  defaultSkills:
    - kind: skill
      ref: design-spec
    - kind: skill
      ref: frontend-polish
    - kind: skill
      ref: design-critique
```

- [ ] **Step 5: catalog 追加 4 条 + 计数**

`resources/marketplace/catalog.json` items 末尾追加：

```json
    {
      "id": "skill-design-spec",
      "type": "skill",
      "slug": "design-spec",
      "name": "设计 spec 契约",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "产出 DESIGN.md 设计契约：token→组件 spec（六状态）→布局响应式→交接清单。",
      "readme": "# 设计 spec 契约\n\n色板/字体/间距 token 化；组件写全六状态；颜色写字面值；DESIGN.md 作为设计与开发的交接契约。",
      "tags": ["design", "spec"],
      "category": "design",
      "iconEmoji": "📐",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-frontend-polish",
      "type": "skill",
      "slug": "frontend-polish",
      "name": "前端审美规范",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "杜绝 AI 味的界面设计准则：排版层级、间距节奏、色彩克制、18 条反模式自查。",
      "readme": "# 前端审美规范\n\n一屏一焦点；4/8 间距节奏；灰阶≤5 档；附反模式清单（emoji 图标/紫蓝渐变/处处胶囊圆角等 18 条）。",
      "tags": ["design", "frontend"],
      "category": "design",
      "iconEmoji": "🖌️",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 3072,
      "installCount": 0
    },
    {
      "id": "skill-design-critique",
      "type": "skill",
      "slug": "design-critique",
      "name": "设计走查评审",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "七大项清单式界面走查（截图取证），分级输出 Blocker/Major/Polish。",
      "readme": "# 设计走查评审\n\n浏览器截图取证→七项走查（布局/层级/对比度/目标/状态/键盘/品牌）→分级评审意见，每条可独立验证。",
      "tags": ["design", "review"],
      "category": "design",
      "iconEmoji": "👁️",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 3072,
      "installCount": 0
    },
    {
      "id": "agent-ui-designer",
      "type": "agent",
      "slug": "ui-designer",
      "name": "UI 设计师",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "产出设计 token、组件 spec 与设计契约（DESIGN.md），并以截图走查评审界面。",
      "readme": "# UI 设计师\n\n你是设计规范守护者——产出设计 token、组件 spec 与设计契约；你审查界面但不直接写产品代码。\n\n工作流：理解需求 → 设计 spec（token/组件六状态/布局响应式）→ DESIGN.md 契约 → 浏览器截图走查（分级评审）→ 反模式自查。",
      "tags": ["design", "spec", "review"],
      "category": "design",
      "iconEmoji": "🎨",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 4096,
      "installCount": 0
    }
```

`electron/tests/marketplace/client.test.ts`：注释 13 → 17；`toBe(13)` → `toBe(17)`。

- [ ] **Step 6: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/preset-consistency.test.ts tests/marketplace/client.test.ts tests/agent/builtin.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add electron/resources/skills/design-spec electron/resources/skills/frontend-polish electron/resources/skills/design-critique electron/resources/agents/ui-designer.yaml resources/marketplace/catalog.json electron/tests/marketplace/client.test.ts
git commit -m "feat: 新增 UI 设计组预设 skill 与 UI 设计师 agent"
```

---

### Task 5: 全栈组（2 新增 + 3 升级）+ coder 升级

**Files:**
- Create: `electron/resources/skills/tdd-workflow/SKILL.md`
- Create: `electron/resources/skills/frontend-best-practices/SKILL.md`
- Modify: `electron/resources/skills/{code-review,write-tests,debug-reproduce}/SKILL.md`（规范化升级，version 1.1.0）
- Modify: `electron/resources/agents/coder.yaml`（version/systemPrompt/defaultSkills/头注释；**defaultTools 段不动**）
- Modify: `resources/marketplace/catalog.json`（2 条新 skill + 3 条更新 + agent-coder 条目更新）
- Modify: `electron/tests/marketplace/client.test.ts:95`（17 → 19）

**Interfaces:**
- Produces: slug `tdd-workflow` / `frontend-best-practices`；coder def 的 defaultSkills = tdd-workflow / frontend-best-practices / code-review / write-tests / debug-reproduce

- [ ] **Step 1: 写 tdd-workflow**

`electron/resources/skills/tdd-workflow/SKILL.md`：

```markdown
---
name: TDD 工作流
description: 测试驱动的实现循环（红-绿-重构）。写新功能或修 bug 需要先写失败测试时使用。
version: 1.0.0
---

# TDD 工作流

## 适用场景

- 新功能实现、bug 修复（先写复现测试）

## 工作流

1. 红：写一个刚好失败的测试——测试名描述行为（"用户名为空时注册失败"），不是方法名
2. 跑一遍确认失败原因正确（失败在断言，不是编译错误）
3. 绿：写最小实现让测试通过——不多写一行用不到的代码
4. 跑测试确认绿
5. 重构：消除重复/改善命名，测试保持绿；重构与写新测试不同时做
6. 循环：下一个行为从第 1 步重来

## 输出规范

- 测试放仓库约定位置（electron 主进程集中 electron/tests/ 镜像 src；renderer 贴源 colocated）

## 硬规则

- NEVER: 先写实现再补测试；为了让测试通过硬编码期望值；跳过第 2 步（没确认过失败的测试可能是恒真的）
- ALWAYS: 修 bug 先写复现测试再改代码；提交前全量测试绿
```

- [ ] **Step 2: 写 frontend-best-practices**

`electron/resources/skills/frontend-best-practices/SKILL.md`：

```markdown
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
```

- [ ] **Step 3: 升级 3 个现有 skill**

`electron/resources/skills/code-review/SKILL.md` 整文件替换为：

```markdown
---
name: 代码审查
description: 以缺陷预防为导向审查代码变更——先看控制流与边界，再提改进建议。用户让"review/审查代码/看看这段代码有没有问题"时使用。
version: 1.1.0
---

# 代码审查

## 适用场景

- 对指定变更（文件 / diff / 模块）执行结构化审查；提交前自检
- 不适用：风格格式化建议（走 lint）、重构设计（另行讨论）

## 工作流

1. 先读全量上下文：不要只看 diff——read_file 打开相关文件理解调用方与被调用方
2. 审查顺序：正确性（逻辑 / 边界 / 空值）→ 并发与竞态 → 资源泄漏 → 错误处理是否吞状态 → 类型安全 → 可读性
3. 每个发现必须给出：严重级别（阻断 / 重要 / 次要）、文件与行号依据、具体修复建议
4. 不确定的行为问题先写复现条件再定性

## 输出规范

- 按严重级别排序的发现清单；无阻断项时明确说「无阻断发现」

## 硬规则

- NEVER: 为风格差异提阻塞意见；没有行号依据的泛泛意见
- ALWAYS: 每条意见附具体修复建议；审查覆盖错误路径与空输入
```

`electron/resources/skills/write-tests/SKILL.md` 整文件替换为：

```markdown
---
name: 编写测试
description: 为指定模块补单元测试——先锁行为再写实现细节，错误路径必须有专项用例。用户让"补测试/写单测/加用例"时使用。
version: 1.1.0
---

# 编写测试

## 适用场景

- 为指定代码补单元测试；为既有行为建回归锁
- 不适用：端到端验收（另走 e2e 流程）

## 工作流

1. 先读被测代码的真实依赖：mock 只收窄到进程 / 网络 / DB 边界，业务逻辑用真实实现
2. 用例覆盖矩阵：正常值 + 边界空值 + 错误路径（错误处理里吞状态的用例必须存在）
3. 断言被消费的字段：id 唯一性、状态枚举、时序——不接受「调用方不应该依赖它」的占位断言
4. 测试放行标准：全绿 + 新增用例能在拿掉实现时变红（先写红再写绿）

## 输出规范

- 测试文件路径 + 用例清单 + 运行命令
- 位置遵循仓库约定：electron 主进程集中 electron/tests/（镜像 src）；renderer 贴源 colocated

## 硬规则

- NEVER: 为「方便测试」简化 mock 语义导致与生产运行时行为不一致；删除失败测试来换取通过
- ALWAYS: 错误路径与空输入有专项用例；mock 的 this 绑定 / ID 唯一性等运行时语义如实仿真
```

`electron/resources/skills/debug-reproduce/SKILL.md` 整文件替换为：

```markdown
---
name: 调试复现
description: 修复 bug 前先建立可靠复现——最小复现、根因假设、逐个排除。用户报"修复无效/为什么不工作/报错/复现"时使用。
version: 1.1.0
---

# 调试复现

## 适用场景

- 接到「修复 X」类请求；用户反馈「修复无效」的复查

## 工作流

1. 最小复现：构造能稳定触发问题的最小输入 / 步骤；无法复现时明确报告阻塞点，不盲改
2. 根因假设：列出至少 2-3 个候选根因，按可能性排序
3. 逐个排除：每个假设给出验证方法（日志 / 断点 / 对照实验）与验证结果
4. 修复后回归锁：把复现步骤固化为失败测试，修复使其变绿
5. 「修复无效」先查构建新鲜度（源码 ↔ 产物是否同源），再怀疑代码

## 输出规范

- 复现步骤 / 根因结论 / 验证证据 / 回归测试路径

## 硬规则

- NEVER: 未定位根因前连续尝试性修改（shotgun debugging）；复现不了就改代码
- ALWAYS: 修复附回归测试；结论有验证证据支撑
```

- [ ] **Step 4: 升级 coder.yaml**

修改 `electron/resources/agents/coder.yaml`——文件头注释替换为：

```yaml
# 程序员 — 实现工程师（四段式 prompt，spec 2026-10-08）。
# 预置库按需启用（builtin 注册链自 v1.1 起休眠）；YAML 与 catalog 双轨先例。
```

`metadata.version: 1.0.0` → `1.1.0`；`spec.type: sub` 与 `spec.parentAgentId: pm-agent` 保留；`defaultTools` 段保留不动；`spec.declarative.systemPrompt` 整块替换为：

```yaml
    systemPrompt: |
      你是实现工程师——先读后写、遵循项目既有风格、测试先行；你从不提交未验证的代码。

      工作流：
      1. 理解需求：有需求文档先 read_file；用 list_files / grep 了解项目结构与既有模式
      2. 按 tdd-workflow 技能循环实现：失败测试 → 最小实现 → 重构
      3. 前端实现遵循 frontend-best-practices 技能的规则
      4. 自检：相关测试全绿；诊断类问题按 debug-reproduce 技能先复现
      5. 提交：git_add → git_commit（遵循项目 commit 规范）；简要说明实现思路

      工具要点：
      - 修改前先读目标文件；改动遵循周围代码的既有风格
      - 调试先复现（debug-reproduce 技能）；审查对照 code-review 技能清单

      硬规则：
      - NEVER: 提交未跑过测试/诊断的代码；引入类型抑制（as any / @ts-ignore）
      - ALWAYS: 错误处理完整；注释与项目语言约定一致
```

在 `defaultTools` 段之后追加：

```yaml
  defaultSkills:
    - kind: skill
      ref: tdd-workflow
    - kind: skill
      ref: frontend-best-practices
    - kind: skill
      ref: code-review
    - kind: skill
      ref: write-tests
    - kind: skill
      ref: debug-reproduce
```

- [ ] **Step 5: catalog 更新 + 计数**

`resources/marketplace/catalog.json` items 末尾追加 2 条：

```json
    {
      "id": "skill-tdd-workflow",
      "type": "skill",
      "slug": "tdd-workflow",
      "name": "TDD 工作流",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "测试驱动实现循环：红（失败测试）→绿（最小实现）→重构，循环推进。",
      "readme": "# TDD 工作流\n\n先写刚好失败的测试并确认失败原因正确，再写最小实现，再重构；修 bug 先写复现测试。",
      "tags": ["tdd", "development"],
      "category": "development",
      "iconEmoji": "♻️",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-frontend-best-practices",
      "type": "skill",
      "slug": "frontend-best-practices",
      "name": "前端最佳实践",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "React 实现质量规则：组合优于配置、派生不存储、渲染性能、bundle 纪律。",
      "readme": "# 前端最佳实践\n\n组合优于配置；状态放使用处；派生不存储；列表 key 稳定；组件 ≤250 行；不过度优化先正确。",
      "tags": ["frontend", "react"],
      "category": "development",
      "iconEmoji": "🧩",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    }
```

并更新 4 条既有条目：
- `skill-code-review`：`version` → `1.1.0`，`description` → `"以缺陷预防为导向审查代码变更。用户让 review/审查代码时使用：六步审查顺序+分级发现清单。"`
- `skill-write-tests`：`version` → `1.1.0`，`description` → `"为指定模块补单元测试。用户让补测试/写单测时使用：mock 保真+覆盖矩阵+先红后绿。"`
- `skill-debug-reproduce`：`version` → `1.1.0`，`description` → `"修复 bug 前先建立可靠复现。用户报修复无效/报错时使用：最小复现→根因假设→排除→回归锁。"`
- `agent-coder`：`version` → `1.1.0`，`description` → `"实现工程师：先读后写、测试先行、提交前自检，从不提交未验证的代码。"`，`readme` → `"# 程序员\n\n你是实现工程师——先读后写、遵循项目既有风格、测试先行。\n\n工作流：读需求与项目结构 → TDD 循环（失败测试→最小实现→重构）→ lsp_diagnostics 自检 → git 提交。"`

`electron/tests/marketplace/client.test.ts`：注释 17 → 19；`toBe(17)` → `toBe(19)`。

- [ ] **Step 6: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/preset-consistency.test.ts tests/marketplace/client.test.ts tests/agent/builtin.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add electron/resources/skills/tdd-workflow electron/resources/skills/frontend-best-practices electron/resources/skills/code-review electron/resources/skills/write-tests electron/resources/skills/debug-reproduce electron/resources/agents/coder.yaml resources/marketplace/catalog.json electron/tests/marketplace/client.test.ts
git commit -m "feat: 新增全栈组预设 skill 并升级程序员 agent"
```

---

### Task 6: 研发管理组 3 个 skill + pm-agent 重定位

**Files:**
- Create: `electron/resources/skills/task-breakdown/SKILL.md`
- Create: `electron/resources/skills/tech-design-review/SKILL.md` + `references/review-checklist.md`
- Create: `electron/resources/skills/sprint-reporting/SKILL.md`
- Modify: `electron/resources/agents/pm-agent.yaml`（重定位：头注释/version/systemPrompt/defaultSkills；**defaultTools 段不动**）
- Modify: `resources/marketplace/catalog.json`（3 条 skill + agent-pm-agent 条目更新）
- Modify: `electron/tests/marketplace/client.test.ts:95`（19 → 22）

**Interfaces:**
- Produces: slug `task-breakdown` / `tech-design-review` / `sprint-reporting`；pm-agent def 的 defaultSkills = 三者 + verification-before-done（Task 2 产出）

- [ ] **Step 1: 写 task-breakdown**

`electron/resources/skills/task-breakdown/SKILL.md`：

```markdown
---
name: 任务分解与排期
description: 把目标拆成可执行、可验收的任务计划。用户提到"排期/计划/任务拆解/里程碑/工作量"时使用。
version: 1.0.0
---

# 任务分解与排期

## 适用场景

- 项目/迭代启动时的规划；大需求转执行计划

## 工作流

1. 目标澄清：一句话写下"做完什么算成功"（可验证的结果，不是"完成开发"）
2. 里程碑切分：按可交付物切 2-4 个里程碑，每个有明确验收物
3. 任务粒度：每条任务 0.5-2 天、可独立验收、能一句话说清"做什么+产出什么"
4. 标依赖：任务间依赖显式标（T3 依赖 T1）；无依赖的标"可并行"
5. 风险清单：每条标 1-2 个风险点 + 触发时的降级方案
6. 输出计划文档（write_file 写入 workspace）

## 输出规范

- Markdown 表格：ID/任务/产出物/预估/依赖/风险

## 硬规则

- NEVER: "调研 XX"这种无产出物的任务条目；把依赖藏进描述里
- ALWAYS: 每条任务有产出物（文档/代码/页面），验收人能判定完成
```

- [ ] **Step 2: 写 tech-design-review + references**

`electron/resources/skills/tech-design-review/SKILL.md`：

```markdown
---
name: 技术方案评审
description: 用工程经理视角评审技术方案/设计文档。用户让"评审方案/看看这个设计/把把关"时使用。
version: 1.0.0
---

# 技术方案评审

## 适用场景

- 技术方案/架构设计文档的正式评审

## 工作流

1. 通读方案（read_file）；先写下方案的目标与声称的取舍（评审锚定它们）
2. 按清单逐项走查（九大项完整清单见 references/review-checklist.md，readResource 加载）
3. 每项输出：✅ 通过理由 / ⚠️ 疑问（需作者澄清）/ ❌ 问题（含影响与建议）
4. 汇总裁决：可合入 / 有条件合入（列条件）/ 需重做（列阻断项）

## 输出规范

- 评审意见 Markdown：按清单项分组；裁决放最前

## 硬规则

- NEVER: "感觉架构有点问题"这种无依据意见；只挑刺不给建设性替代
- ALWAYS: ❌ 问题必须附影响范围与至少一个可行方向；先评方案自己声称的取舍是否成立
```

`electron/resources/skills/tech-design-review/references/review-checklist.md`：

```markdown
# 技术方案评审清单

九大项逐项走查：

## 1. 目标匹配
- 方案声称解决的问题与真实目标一致？是否引入了目标外的新依赖面

## 2. 架构合理性
- 模块边界与职责是否清晰；数据流向是否单向可追
- 是否过度设计（YAGNI）/ 欠设计（无扩展点）

## 3. 边缘 case
- 空输入 / 极值 / 并发 / 部分失败 是否有明确定义行为

## 4. 失败模式
- 依赖服务挂掉时的降级路径；重试/幂等/超时策略

## 5. 性能与容量
- 数据量增长后的瓶颈点；有无不必要的同步阻塞 / N+1

## 6. 安全
- 输入校验位置（信任边界）；权限检查；敏感数据落盘/日志

## 7. 迁移与回滚
- 旧数据如何迁移；上线出问题如何回滚；是否可灰度

## 8. 测试策略
- 关键路径有无回归锁；错误路径是否可测

## 9. 监控告警
- 上线后如何知道它是好的（指标/日志/告警阈值）
```

- [ ] **Step 3: 写 sprint-reporting**

`electron/resources/skills/sprint-reporting/SKILL.md`：

```markdown
---
name: 周报与状态汇报
description: 写周报、项目状态更新。用户提到"周报/进展汇报/状态更新/项目简报"时使用。
version: 1.0.0
---

# 周报与状态汇报

## 适用场景

- 周报/双周报/里程碑汇报

## 工作流

1. 收集事实：从任务板提取本周完成、进行中、阻塞（list_tasks / read_task_history）
2. 三段式组织：
   - 进展：完成了什么（对齐目标说结果，不流水账）
   - 风险：什么可能延期/什么已阻塞 + 需要的支援
   - 待决策：需要对方拍板的选项（每个给推荐项）
3. 反 AI 腔：按 humanize-writing 技能的方法过一遍
4. 数字优先：完成率、剩余量、燃尽位置比形容词有力

## 输出规范

- 篇幅一屏内；标题 =「<项目>周报 <日期范围>」

## 硬规则

- NEVER: 报喜不报忧（风险段空着）；写"持续推进中"这种零信息条目
- ALWAYS: 每条进展可追溯到任务；风险必须有影响与应对
```

- [ ] **Step 4: pm-agent 重定位**

修改 `electron/resources/agents/pm-agent.yaml`——文件头注释替换为：

```yaml
# 项目经理 — 研发管理向（四段式 prompt，spec 2026-10-08 重定位）。
# v25 团队机制下编排是系统能力（leader 自动获得 dispatch 注入），prompt 主打管理职能。
# 预置库按需启用（builtin 注册链自 v1.1 起休眠）；YAML 与 catalog 双轨先例。
```

`metadata.version: 1.0.0` → `1.1.0`；`metadata.description` → `"研发管理：任务分解与排期、技术方案评审、周报与状态汇报。"`；`spec.type: main` 保留；`defaultTools` 段保留不动；`spec.declarative.systemPrompt` 整块替换为：

```yaml
    systemPrompt: |
      你是研发管理者——拆解任务、评审方案、产出排期与汇报；编排派发交给团队机制，你不亲自写代码。

      工作流：
      1. 规划：按 task-breakdown 技能把目标拆成里程碑与可独立验收的任务，计划文档写入 workspace
      2. 评审：按 tech-design-review 技能的清单评审技术方案，给出分级裁决
      3. 汇报：按 sprint-reporting 技能产出周报/状态汇报（进展/风险/待决策）
      4. 作为团队 leader 时用 dispatch:<slug> 派发任务（系统自动提供），收齐 task_reply 后汇总

      工具要点：
      - 事实从任务板取：list_tasks / read_task_history
      - 计划与汇报 write_file 写入 workspace 的 docs/ 目录

      硬规则：
      - NEVER: 亲自写产品代码；排期出现没有产出物定义的任务
      - ALWAYS: 每条任务可验收；汇报数据可追溯到任务；风险必附影响与应对
```

在 `defaultTools` 段之后追加：

```yaml
  defaultSkills:
    - kind: skill
      ref: task-breakdown
    - kind: skill
      ref: tech-design-review
    - kind: skill
      ref: sprint-reporting
    - kind: skill
      ref: verification-before-done
```

- [ ] **Step 5: catalog 更新 + 计数**

`resources/marketplace/catalog.json` items 末尾追加 3 条：

```json
    {
      "id": "skill-task-breakdown",
      "type": "skill",
      "slug": "task-breakdown",
      "name": "任务分解与排期",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "把目标拆成可执行计划：里程碑→0.5-2 天可验收任务→依赖标注→风险降级。",
      "readme": "# 任务分解与排期\n\n目标一句话可验证；里程碑按交付物切；每条任务有产出物；依赖显式标；风险附降级方案。",
      "tags": ["planning", "management"],
      "category": "management",
      "iconEmoji": "🧱",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-tech-design-review",
      "type": "skill",
      "slug": "tech-design-review",
      "name": "技术方案评审",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "九大项清单式技术方案评审（目标/架构/边缘case/失败/性能/安全/迁移/测试/监控）。",
      "readme": "# 技术方案评审\n\n先锚定方案声称的目标与取舍；九大项逐项走查；每项 ✅/⚠️/❌；裁决=可合入/有条件/需重做。",
      "tags": ["review", "architecture"],
      "category": "management",
      "iconEmoji": "⚖️",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 3072,
      "installCount": 0
    },
    {
      "id": "skill-sprint-reporting",
      "type": "skill",
      "slug": "sprint-reporting",
      "name": "周报与状态汇报",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "进展/风险/待决策三段式周报，事实从任务板取，数字优先。",
      "readme": "# 周报与状态汇报\n\n从任务板取事实；三段式（进展对齐目标/风险附支援需求/待决策给推荐项）；过反 AI 腔；一屏内。",
      "tags": ["reporting", "management"],
      "category": "management",
      "iconEmoji": "📢",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    }
```

并更新 `agent-pm-agent` 条目：`version` → `1.1.0`，`description` → `"研发管理：任务分解与排期、技术方案评审、周报与状态汇报。"`, `readme` → `"# 项目经理\n\n你是研发管理者——拆解任务、评审方案、产出排期与汇报；编排派发交给团队机制。\n\n工作流：任务分解（可验收粒度+依赖+风险）→ 方案评审（九项清单+分级裁决）→ 周报（进展/风险/待决策）。"`, `tags` → `["project-management", "planning", "review"]`。

`electron/tests/marketplace/client.test.ts`：注释 19 → 22；`toBe(19)` → `toBe(22)`。

- [ ] **Step 6: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/preset-consistency.test.ts tests/marketplace/client.test.ts tests/agent/builtin.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add electron/resources/skills/task-breakdown electron/resources/skills/tech-design-review electron/resources/skills/sprint-reporting electron/resources/agents/pm-agent.yaml resources/marketplace/catalog.json electron/tests/marketplace/client.test.ts
git commit -m "feat: 新增研发管理组预设 skill 并重定位项目经理 agent"
```

---

### Task 7: 文档办公组 4 个 skill + office-assistant 微升级

**Files:**
- Create: `electron/resources/skills/excel-analysis/SKILL.md` + `references/formulas.md`
- Create: `electron/resources/skills/ppt-authoring/SKILL.md`
- Create: `electron/resources/skills/pdf-extraction/SKILL.md`
- Create: `electron/resources/skills/doc-formatting/SKILL.md`
- Modify: `electron/resources/agents/office-assistant.yaml`（version/追加技能挂载段/defaultSkills；**systemPrompt 既有内容与 defaultTools 段一律不动**——builtin-office.test.ts 契约锁依赖）
- Modify: `resources/marketplace/catalog.json`（4 条 skill + agent-office-assistant 条目更新 + `updatedAt`）
- Modify: `electron/tests/marketplace/client.test.ts:95`（22 → 26）

**Interfaces:**
- Produces: slug `excel-analysis` / `ppt-authoring` / `pdf-extraction` / `doc-formatting`；office-assistant def 的 defaultSkills = 四者 + doc-coauthoring + humanize-writing

- [ ] **Step 1: 写 excel-analysis + references**

`electron/resources/skills/excel-analysis/SKILL.md`：

```markdown
---
name: Excel 公式实战
description: 用公式做数据汇总、统计与图表。用户要"汇总表/统计/数据透视/报表/图表"或提供 Excel 让分析时使用。
version: 1.0.0
---

# Excel 公式实战

## 适用场景

- Excel 数据汇总 / 统计报表 / 图表页构建

## 工作流

1. 先读后写：office_read 预览结构 → office_read_cells 精读关键区域；写/覆盖前必须先读
2. 汇总一律写公式引用明细区（不由上下文心算）：条件求和 =SUMIF、多条件 =SUMPRODUCT、计数 =COUNTIF、查找 =VLOOKUP（公式模式速查见 references/formulas.md，readResource 加载）
3. 批量明细数据用 fill 声明式生成（列规格+行数+seed），不手写大数组
4. 格式分离：先 set_cells 写值，再 set_format 设显示格式（白名单：0.0% / #,##0 / 0.00 / yyyy-mm-dd / ¥#,##0）
5. 图表页：set_cells 写汇总数 → add_chart 引用数据区域；数据先于图表写入
6. 验证：office_read_cells 抽样回读比对

## 硬规则

- NEVER: 在上下文心算大量数字填进单元格；把显示格式混进单元格值
- ALWAYS: 汇总数可追溯到公式；每批写入 ≤50 行
```

`electron/resources/skills/excel-analysis/references/formulas.md`：

```markdown
# Excel 公式模式速查（按场景）

## 条件汇总
- 单条件求和：=SUMIF(明细!C:C, A10, 明细!I:I)
- 多条件求和：=SUMPRODUCT((明细!C:C=A10)*(明细!D:D="华东")*明细!I:I)
- 单条件计数：=COUNTIF(明细!C:C, A10)
- 多条件计数：=SUMPRODUCT((明细!C:C=A10)*(明细!D:D="华东"))

## 查找引用
- 精确查找：=VLOOKUP(C10, 目录区, 2, 0)（目录区首列必须是查找键）
- 防错查找：=IFERROR(VLOOKUP(...), "未匹配")

## 派生列
- 月份：=MONTH(A10)；年月文本：=TEXT(A10, "yyyy-mm")
- 条件值：=IF(库存<安全线, "预警", "")
- 分档：=IF(值>=90,"A",IF(值>=75,"B","C"))

## 显示格式（set_format 白名单）
0.0%（百分比）｜#,##0（千分位整数）｜0.00（两位小数）｜yyyy-mm-dd（日期）｜¥#,##0（人民币）

## 组合模式
- 汇总页引用明细：A 列放维度（类别/月份），B 列起逐列 =SUMIF/=COUNTIF 引用明细区
- 预警清单：明细页加公式列 =IF(条件, 标记, "")，汇总页 =COUNTIF(明细!标记列, 标记) 计数
- 图表数据：先 set_cells 写好汇总区，add_chart 引用该区域（公式格缓存留空，Excel 打开后自动计算）
```

- [ ] **Step 2: 写 ppt-authoring**

`electron/resources/skills/ppt-authoring/SKILL.md`：

```markdown
---
name: PPT 汇报构建
description: 构建结构清晰的汇报 PPT。用户要"做 PPT/汇报 slides/演示文稿"时使用。
version: 1.0.0
---

# PPT 汇报构建

## 适用场景

- 从主题或素材产出 .pptx 汇报

## 工作流

1. 定叙事：先出大纲（每页：标题 + 一句话要点 + 页型[封面/章节/内容/图表/结尾]），用户确认后再生成
2. 信息层级：每页一个核心观点；标题写结论句（"Q3 增长 23%"）不写分类句（"Q3 数据"）
3. 图表优先：数据页用 add_chart 原生图表（柱/横条/折线/饼），数据先 office_read_cells 取数
4. 模板决策：默认 office_create_ppt（可带页背景/插图/原生图表）；用户给 .pptx 模板且要保留品牌 → office_fill_ppt_template 按页填充（模板字节不动）
5. 文字纪律：每页 ≤6 行要点，每行 ≤18 字；禁止整段文字贴页
6. 生成后告知路径与迭代方式

## 硬规则

- NEVER: 大纲未确认就生成全篇；一页塞两个主题
- ALWAYS: 数据图表先取数再建图；标题是结论不是分类
```

- [ ] **Step 3: 写 pdf-extraction**

`electron/resources/skills/pdf-extraction/SKILL.md`：

```markdown
---
name: PDF 提取与问答
description: 从 PDF 提取内容、做摘要问答与比对。用户给 PDF 让"看内容/提取/总结/比对"时使用。
version: 1.0.0
---

# PDF 提取与问答

## 适用场景

- PDF 阅读、结构化提取、跨文档比对

## 工作流

1. office_read 读取 PDF 内容与结构
2. 按目的处理：
   - 问答：定位相关段落引用原文页码作答，不给无出处结论
   - 提取：按目标 schema 结构化输出（表格/字段清单），标注每条来源页
   - 比对：逐节对照，差异表（位置/文档A/文档B）
   - 摘要：分级摘要（一段总述 + 分节要点），保留关键数字
3. 产出写 workspace 文件（Markdown/Excel），对话给摘要

## 硬规则

- NEVER: 编造 PDF 里没有的内容；引用不给页码
- ALWAYS: 提取结果标注来源页码；无法提取时（如扫描件）明说并建议转文字版
```

- [ ] **Step 4: 写 doc-formatting**

`electron/resources/skills/doc-formatting/SKILL.md`：

```markdown
---
name: Word 长文档排版
description: 生成结构规范的 Word 长文档。用户要"Word 文档/报告排版/正式文档"时使用。
version: 1.0.0
---

# Word 长文档排版

## 适用场景

- 正式报告/说明书/方案文档的 .docx 产出

## 工作流

1. 定结构：标题层级 ≤3 级；先列目录级大纲确认
2. 内容规范：一段一个论点（3-6 句）；表格承载数据对比，不用列表硬排
3. 生成：office_create_doc 产出；样式走文档内置样式，不手动加粗凑标题
4. 图表编号与引用：图/表按章编号（图 2-1），正文有"如图 2-1"引用
5. 收尾检查：目录与实际标题一致；术语前后一致

## 硬规则

- NEVER: 用空格/回车对齐排版；同一文档两种标题字号体系
- ALWAYS: 超过 3 页的文档带目录；数据表注明数据来源与时间
```

- [ ] **Step 5: office-assistant 微升级**

修改 `electron/resources/agents/office-assistant.yaml`：
- `metadata.version: 1.0.0` → `1.1.0`
- **systemPrompt 既有内容（工作流 1-10 + 原则）一律保留不动**（契约锁依赖）；仅在「原则」段之后追加：

```yaml

      技能挂载：
      - Excel 汇总/图表 → 按 excel-analysis 技能执行
      - PPT 汇报 → 按 ppt-authoring 技能执行
      - PDF 处理 → 按 pdf-extraction 技能执行
      - Word 排版 → 按 doc-formatting 技能执行
      - 长文档共创 → 按 doc-coauthoring 技能执行；对外文案过 humanize-writing
      任务匹配已挂载技能时先 loadSkill 加载再执行。
```

- 在 `defaultTools` 段之后追加：

```yaml
  defaultSkills:
    - kind: skill
      ref: excel-analysis
    - kind: skill
      ref: ppt-authoring
    - kind: skill
      ref: pdf-extraction
    - kind: skill
      ref: doc-formatting
    - kind: skill
      ref: doc-coauthoring
    - kind: skill
      ref: humanize-writing
```

- [ ] **Step 6: catalog 更新 + 计数 + updatedAt**

`resources/marketplace/catalog.json` items 末尾追加 4 条：

```json
    {
      "id": "skill-excel-analysis",
      "type": "skill",
      "slug": "excel-analysis",
      "name": "Excel 公式实战",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "公式驱动的数据汇总与图表：SUMIF/VLOOKUP 模式、fill 生成、set_format 分离、add_chart。",
      "readme": "# Excel 公式实战\n\n汇总一律写公式引用明细区不心算；先读后写；值与显示格式分离；附公式模式速查（references/formulas.md）。",
      "tags": ["excel", "office"],
      "category": "productivity",
      "iconEmoji": "📊",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 3072,
      "installCount": 0
    },
    {
      "id": "skill-ppt-authoring",
      "type": "skill",
      "slug": "ppt-authoring",
      "name": "PPT 汇报构建",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "结论句标题+图表优先+模板决策的汇报 PPT 构建方法。",
      "readme": "# PPT 汇报构建\n\n先大纲确认再生成；标题写结论句；数据页 add_chart 原生图表；模板场景走 office_fill_ppt_template。",
      "tags": ["ppt", "office"],
      "category": "productivity",
      "iconEmoji": "📽️",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-pdf-extraction",
      "type": "skill",
      "slug": "pdf-extraction",
      "name": "PDF 提取与问答",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "PDF 结构化提取/问答/比对/摘要，引用必附页码。",
      "readme": "# PDF 提取与问答\n\noffice_read 读取后按目的处理（问答/提取/比对/摘要）；提取结果标注来源页码；不给无出处结论。",
      "tags": ["pdf", "office"],
      "category": "productivity",
      "iconEmoji": "📑",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "skill-doc-formatting",
      "type": "skill",
      "slug": "doc-formatting",
      "name": "Word 长文档排版",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "结构规范的 Word 长文档：层级≤3、内置样式、图表编号引用、目录一致。",
      "readme": "# Word 长文档排版\n\n目录级大纲先行；一段一论点；office_create_doc 内置样式；图表按章编号；>3 页带目录。",
      "tags": ["word", "office"],
      "category": "productivity",
      "iconEmoji": "📘",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    }
```

并做两处更新：
- `agent-office-assistant` 条目：`version` → `1.1.0`；`readme` 在末尾追加一段（保留原有全部内容，契约锁关键词不动）：`"\n\n技能挂载：Excel 汇总/图表→excel-analysis；PPT 汇报→ppt-authoring；PDF 处理→pdf-extraction；Word 排版→doc-formatting；长文档共创→doc-coauthoring。"`
- 顶层 `updatedAt` → `"2026-10-08T00:00:00Z"`

`electron/tests/marketplace/client.test.ts`：注释 22 → 26；`toBe(22)` → `toBe(26)`。

- [ ] **Step 7: 跑测试（含 office 契约锁全量复跑）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/preset-consistency.test.ts tests/marketplace/client.test.ts tests/agent/tools/office/builtin-office.test.ts`
Expected: 全部 PASS（builtin-office 契约锁：office-assistant defaultTools 仍 27 项、readme 关键词全在——本任务未动 systemPrompt 主体与 defaultTools）

- [ ] **Step 8: Commit**

```bash
git add electron/resources/skills/excel-analysis electron/resources/skills/ppt-authoring electron/resources/skills/pdf-extraction electron/resources/skills/doc-formatting electron/resources/agents/office-assistant.yaml resources/marketplace/catalog.json electron/tests/marketplace/client.test.ts
git commit -m "feat: 新增文档办公组预设 skill 并升级办公助理 agent"
```

---

### Task 8: 全量验收 + 研发账本

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1-7 全部产出（终态：5 agent YAML / 20 skill 目录 / catalog 26 items）

- [ ] **Step 1: 类型检查**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 双 workspace 0 error

- [ ] **Step 2: 双 workspace 全量测试**

Run: `npx pnpm@9.0.0 test`
Expected: electron + renderer 全绿（无任何因 catalog/YAML/skill 内容引起的回归）

- [ ] **Step 3: dev 启动手检（macOS 主机）**

Run: `npx pnpm@9.0.0 dev`，按清单操作：
1. 资源库 builtin tab：可见 5 个 agent（含 UI 设计师🎨）+ 20 个 skill，条目与目录一致
2. 预置库（AddMenu 启用预置库）：可见 5 个 agent；启用「UI 设计师」成功
3. 建 UI 设计师会话，发一条「帮我评审一下某个页面的设计」——确认 agent 能调用 loadSkill 加载 design-critique 并按清单工作
4. 启用「办公助理」，发「帮我做一个销售汇总 Excel」——确认 excel-analysis 技能挂载生效

Expected: 四项全过。若手检失败按 momo-debug-rules 流程排查（先复现后修复）

- [ ] **Step 4: 研发账本**

读 `CHANGELOG.md` 头部 40 行确认现有 2.1.0-alpha 小节的条目格式，按同样式追加一行（不动版本号）：

```
- 预设内容库：五角色 agent（新增 UI 设计师 + 4 个升级，pm-agent 重定位研发管理向）+ 20 个 builtin skill（17 新增 + 3 规范化）+ catalog 双轨对齐修复（skill 条目与目录一一对齐）
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 预设内容库研发账本条目"
```
