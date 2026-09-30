# Resource Library UI Patterns — Mainstream AI/Agent Desktop Apps

> Research date: 2026-09-22
> Researcher: THE LIBRARIAN
> Purpose: Feed into Momo Studio resource library redesign (3-type: Agent YAML / MCP / Skill SKILL.md)
> Downstream: rebuild UI mockups for per-type add flows

---

## TL;DR — Counter to the Rejected Proposal

The user's "uniform 3-path add flow" proposal is **not** how mainstream apps do it. Every reviewed app uses **type-specific flows**. Even within a single type, the add surface is split across multiple entry points (manual form, JSON/file paste, marketplace one-click, system discovery, CLI).

A shared wizard is the exception — Cherry Studio uses one only for `assistant + agent`, never for MCP or skills.

The friendliness comes from:
1. **Discovering what's already there** (CLI skills, local MCPs)
2. **Auto-config from content** (readme → MCP configSample)
3. **Keeping the simplest path visible** (don't bury JSON paste)

---

## 1. Cherry Studio (`CherryHQ/cherry-studio`) — User's Reference

Three resource types with **three different UI surfaces each**, all under Settings:
- MCP: `/settings/mcp/...`
- Skills: `/settings/skills`
- Agents: `pages/agents/`

Routes documented at [zread 15-page-and-route-structure](https://zread.ai/CherryHQ/cherry-studio/15-page-and-route-structure).

### 1a. MCP Servers

**Management surface.** Five separate routes:
- `/settings/mcp/servers` — list (`McpServersList`)
- `/settings/mcp/builtin` — preset servers (`BuiltinMcpServerList`)
- `/settings/mcp/marketplaces` — external link cards (`McpMarketList`)
- `/settings/mcp/npx-search` — npm scope browser (`NpxSearch`)
- `/settings/mcp/settings/:serverId` — per-server detail (`McpSettings`)
- `/settings/mcp/mcp-install` — protocol deep-link install (`McpProtocolInstallDialog`)

[McpServersList](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServersList.tsx#L60-L75)

**The "+" button is a 4-option dropdown, NOT a single "Add":**
- 手动添加 (Manual create) → `QuickCreateMcpServerDialog`
- 从 JSON 导入 (Import from JSON) → `AddMcpServerModal`
- 从 DXT 导入 (Import from DXT) → `AddMcpServerModal`
- 从 MCPB 导入 (Import from MCPB) → `AddMcpServerModal`

[McpServersList dropdown](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServersList.tsx#L270-L290)

**Manual form (`QuickCreateMcpServerDialog`).** Single dialog, two visible sections + advanced accordion:
- **Identity**: name, type select (`stdio` / `sse` / `streamableHttp`), description
- **Endpoint**: command textbox placeholder `uvx or npx` (stdio) OR URL textbox (sse/streamableHttp) placeholder `http://localhost:3000/mcp`
- **Args** (stdio only): multi-line textarea
- **Advanced** (collapsible): registry mirror (npm Taobao / pip Tsinghua etc. based on command), env `KEY=VALUE` per line, long-running toggle, timeout (sec)

[QuickCreateMcpServerDialog](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/QuickCreateMcpServerDialog.tsx#L84-L150)
[McpServerFields](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServerFields.tsx#L165-L260)

**Schema validation gates submit:** sse/streamableHttp need `baseUrl`; stdio needs `command`. Names must be unique (duplicate check on save).

[Schema](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServerFields.tsx#L21-L45)

**Friendliness tricks:**
- `npx` → auto-shows npm mirror picker. `uvx` → shows pip mirror picker.
  [registryForCommand](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServerFields.tsx#L106-L115)
- Auto-detects MCP config from npm README: `getMcpConfigSampleFromReadme` parses JSON examples so one-click install fills args/env.
  [NpxSearch](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/NpxSearch.tsx#L52-L80)
- Already-installed packages show `Check` icon, button disabled.
  [NpxSearch](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/NpxSearch.tsx#L155-L170)
- Per-server runtime status badge (disabled / connecting / connected / error) with semantic colors.
  [McpSettings](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpSettings.tsx#L260-L280)
- Built-in servers (QVeris, etc.) keep identity locked but allow transport-specific config.
  [McpServerFields isBuiltin branch](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServerFields.tsx#L296-L320)
- `mcp://` OS-protocol install: `McpProtocolInstallDialog` listens for `mcp.protocol_install.*` IPC requests (browser deep link).
- Export via Data Settings → backup (full JSON dump including MCP config).
  [Cherry Studio docs](https://docs.cherryai.com.cn)

**Marketplace is NOT a hosted catalog — it's 11 curated external link cards:**
MCP World, BigModel, modelscope, higress, mcp.so, smithery, glama, pulsemcp, composio, official GitHub, awesome-mcp-servers list. Each opens in browser. Honest "we don't host, we curate where to find."

[McpMarketList](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpMarketList.tsx#L21-L100)

### 1b. Skills

**Management surface.** Flat `SkillsSettings.tsx` with single `ResourceCatalogView` underneath (generic catalog, `resourceType="skill"`). Tabs: All / System / Builtin.

[SkillsSettings](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/SkillsSettings.tsx#L20-L50)

**Three SEPARATE dialogs for adding — no single "+" form:**

1. **`ImportSkillDialog`** — local file install only (drag-drop ZIP/directory or button pick). Multi-file queue with per-item status icon. Probes dropped entries via `file.get_metadata` to distinguish zip vs directory. Auto-error on non-zip/non-directory drops. Batch status messaging.

   [ImportSkillDialog](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/skill/ImportSkillDialog.tsx#L150-L250)

2. **`SkillMarketplaceDialog`** — online marketplace with 4 source tabs:
   - `skills.sh`, `claude-plugins.dev`, `clawhub.ai` (keyword search, debounced 300ms)
   - `github` (URL input instead of keywords, e.g., paste `owner/repo`)
   Per-result install button: `Download` → `Loader2` → `Check (installed)`. Shows star + download meta. Empty/loading/error states all rendered.

   [SkillMarketplaceDialog](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/skill/SkillMarketplaceDialog.tsx#L60-L150)

3. **`SystemSkillDialog`** — discovers skills already installed in **other agent CLIs** on the same machine: Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`), Cursor (`~/.cursor/skills`), Gemini CLI, GitHub Copilot, OpenCode, OpenClaw, ClawdBot, MoltBot, Qoder, Qwen Code, plus generic Agent Skills path.

   [systemSkillSources](https://github.com/CherryHQ/cherry-studio/blob/master/src/main/ai/skills/systemSkillSources.ts#L18-L50)

Each candidate has status: `available` → button "Import" / `registered` → button "Imported" / `conflict` (name collision) → button "Conflict". Two modes: `manage` (library settings) and `agent-create` (from agent wizard).

[SystemSkillDialog](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/skill/SystemSkillDialog.tsx#L100-L175)

**Install under the hood.** Atomic commit pattern with backup-restore: rename existing to `.bak`, copy, verify SHA-256 of every file, commit.

[SkillInstaller](https://github.com/CherryHQ/cherry-studio/blob/master/src/main/ai/skills/SkillInstaller.ts#L19-L55)

### 1c. Agents (and Assistants)

**Management surface.** `pages/agents/` is Agent chat runtime. `components/AgentCreateDialog.tsx` is the create button → renders a `ResourceCreateWizard`.

**The wizard IS shared between `assistant` and `agent` kinds** (`kind: 'assistant' | 'agent'`). NOT shared with skill or MCP.

[ResourceCreateWizard](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/create/ResourceCreateWizard.tsx#L182-L230)

Steps (left-rail nav with numbered circles, current/done state):

1. **Basic Info** — avatar (emoji picker) + name + (agent-only) AgentRuntimeTiles (claude-code / opencode / etc.) + permission mode + model selector + description. Auto-selects default model on open if usable.
   [BasicInfoStep](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/create/steps/BasicInfoStep.tsx#L130-L170)
2. **System Prompt** — large textarea.
3. **Capability** (agent-only, hidden if runtime doesn't support skills) — multi-select skill binding. Calls `SystemSkillDialog` in `agent-create` mode.
4. **Knowledge Bases** (hidden if runtime doesn't support) — multi-select knowledge binding.

Step list computed dynamically from `AGENT_RUNTIME_CAPABILITIES[agentType]` — per-runtime UX without forking the wizard.

[Steps logic](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/create/ResourceCreateWizard.tsx#L162-L170)

**Friendliness trick:** changing agentType resets modelId because model compatibility differs by runtime.

---

## 2. Claude Code / Claude Desktop / claude.ai (Anthropic)

### 2a. Claude Code CLI — `claude mcp add`

Four transports, four options:

```bash
claude mcp add --transport http <name> <url> --header "Authorization: Bearer ..."
claude mcp add --transport sse <name> <url>
claude mcp add --transport ws '{"type":"ws","url":"wss://...","headers":{...}}'
claude mcp add [options] <name> -- <command> [args...]    # stdio, -- separates
claude mcp add-json <name> '{"command":"npx","args":["-y","@x/y"]}'
```

[Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

`/mcp` panel shows status icons: `✔ Connected`, `! Needs authentication`, `✘ Failed to connect`, `⏸ Pending approval`, `⊘ Disabled`. Per-server toggle without removing.

**Skills** (Claude Code): per project, `.claude/skills/<name>/SKILL.md`. YAML frontmatter with `name`. Slash-command style invocation.

[Claude Code skills docs](https://code.claude.com/docs/en/skills)

**Plugin marketplace**: `/plugin marketplace add anthropics/claude-plugins-official`.
[Claude plugins repo](https://github.com/anthropics/claude-plugins-official)

### 2b. claude.ai / Claude Desktop — Connectors

**Add custom connector** flow (remote MCP only):
> Customize > Connectors → "+" → "Add custom connector" → enter remote MCP server URL → optionally configure OAuth credentials → Add.

[Claude support docs](https://support.claude.com/en/articles/get-started-with-custom-connectors-using-remote-mcp)

3 fields: Name, Server URL, OAuth (optional). No JSON paste in claude.ai. Connector URL = streamable-HTTP endpoint.

**Skills surface**: claude.ai has no public "Skills" tab as of late 2025 — Skills exist primarily in Claude Code CLI / dev surfaces.

---

## 3. Cline / Roo Code (VS Code extensions)

**Unified marketplace view** handling 3 primitive types via top-nav tabs. `MarketplaceView.tsx` = single page with **type tabs × section tabs**:

- Type tabs: **Skills** (SparklesIcon) / **MCP Servers** (PlugIcon) / **Plugins** (PuzzleIcon, hidden in extension)
- Section tabs: **Installed** / **Marketplace**

[MarketplaceView](https://github.com/cline/cline/blob/master/apps/vscode/webview-ui/src/components/marketplace/MarketplaceView.tsx#L48-L100)

**Per-type UI inside the view:**

- **MCP tab** → special `McpManagementPanel`: list of installed servers (ServersToggleList, with trash icon), "Add Remote Server" primary button (opens `AddRemoteServerForm` inline), "Edit Configuration" secondary button (opens mcp.json), "Advanced MCP Settings" link. Org-managed servers surface a lock-icon callout.

- **Skills tab** → list rows with name + description + origin pill (Global / Workspace / Remote) + path + toggle switch + trash button.

- **Marketplace section** → catalog rows with name + description + meta pills (author, "Requires ENV_KEY") + Download button → Spinner → Check.

**Per-row UX:**
- Toggle switch enable/disable without uninstalling
- Trash icon uninstalls (with confirmation)
- Conflict awareness: "Remote-managed skills cannot be uninstalled here"

[MarketplaceView](https://github.com/cline/cline/blob/master/apps/vscode/webview-ui/src/components/marketplace/MarketplaceView.tsx#L420-L490)

**Add server methods (MCP):**
1. **Marketplace one-click install** (per catalog row)
2. **CLI wizard** — `cline mcp` interactive prompts name + transport + command/URL
3. **JSON edit** — `~/.cline/mcp.json` direct edit
4. **Remote form** — Add Remote Server form (Name + URL + Streamable HTTP / SSE dropdown)

[Cline MCP docs](https://docs.cline.bot/mcp/mcp-marketplace)

**Skill/MCP distinction handled by type tab, NOT separate dialogs** — same list component, same install/uninstall code path, different entry types in proto. `entry.type` = `'mcp' | 'skill' | 'plugin'`.

[MarketplaceEntry](https://github.com/cline/cline/blob/master/apps/vscode/webview-ui/src/components/marketplace/MarketplaceView.tsx#L18-L20)

**Roo Code**: clones Cline's pattern. [Roo-Code MCP docs](https://roocodeinc.github.io/docs/features/mcp/using-mcp-in-roo-code): "Edit Project MCP — or create `.roo/mcp.json` at the root."

---

## 4. LobeChat (`lobehub/lobe-chat`)

**Custom plugin creation** uses a single `DevModal` component with two panes:
- Left: `MCPManifestForm` (for MCP plugins) — fields for MCP URL/auth type/OAuth
- Right: `PluginPreview` — live preview of manifest as you edit

[DevModal](https://github.com/lobehub/lobe-chat/blob/main/src/features/PluginDevModal/index.tsx)

**OAuth handling**: opens popup **synchronously in user gesture** (browsers block async-open), then `onSave` navigates popup to authorize URL. If validation fails, popup closes.

Plugin types: tool-type plugins defined by JSON manifest ([lobehub/chat-plugin-template](https://github.com/lobehub/chat-plugin-template)). Custom plugins install by **manifest URL**.

**Plugin discovery**: `lobehub/lobe-chat-plugins` = marketplace index repo (300+ plugins in index.json).

[Self-host troubleshooting](https://lobehub.com/docs/self-hosting/advanced/plugins/usage): "Check plugin manifest URL is accessible; verify manifest JSON is valid; confirm OpenAPI spec is correctly formatted." So manifest URL is the install primitive.

---

## 5. Dify (`langgenius/dify`)

**DSL import is the headline create method** for apps. Dify DSL = YAML format capturing complete app config.

[Manage Apps docs](https://docs.dify.ai/en/cloud/use-dify/workspace/app-management): "All Dify apps can be exported into a YAML file in Dify's own DSL (Domain-Specific Language) and you may create Dify apps from these DSL files directly."

**DSL drag-drop flow:**
- `create-from-dsl-modal/uploader.tsx` is the component
- `use-dsl-drag-drop` hook enables full-page drag-drop (not just dropzone)
- Accepts `.yaml`, `.yml`, `.ifpkg` extensions; rejects others
- Also URL import: paste a `.ifpkg` link or DSL URL

[Drag-drop hook](https://github.com/langgenius/dify/blob/main/web/app/components/apps/hooks/use-dsl-drag-drop.ts)

**Plugin types** (6): Tool / Model / Agent Strategy / Extension / Datasource / Trigger.

[Dify Plugin docs](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type)

**Plugin marketplace**: both plugin and template galleries. Trending slides on home with creator profiles.

**Agent/assistant create flow**: "configure prompt and add knowledge base to assistant's context." Prompt + knowledge binding = standard agent create form.

---

## 6. Coze / 扣子 (`coze-dev/coze-studio`)

**Three plugin categories:**
- 官方内置插件 (official built-in)
- 自定义插件 (user-created)
- 商业版插件 (paid, coze.cn)

[Coze Studio wiki](https://github.com/coze-dev/coze-studio/wiki/4.-插件配置): custom plugin flow = 资源库 → +资源 → 插件 → 对话框配置

**Two creation paths:**
1. **Form-based** — for one-off tools: name, request/response format, auth, URL
2. **JSON / YAML bulk import** — "when many plugins or many params" — recommended bulk path

[Plugin docs](https://docs.coze.cn): "通过JSON 和YAML 文件导入插件的方式更为高效和灵活"

**Architecture**: all plugins are **OpenAPI 3.0 docs** underneath. "无论是官方插件还是用户自定义的工具，其本质都被统一建模为一份 OpenAPI 文档."

**Plugin = container, Tool = unit**: each plugin can contain multiple tools, all sharing the same domain. Wizard first creates plugin (name + base URL), then adds tools one-by-one.

---

## 7. AnythingLLM / Chatbox / ChatWise

**AnythingLLM**:
- MCP: **edit JSON file only** — `anythingllm_mcp_servers.json`. No form UI.
  [Source](https://docs.useanything.com)
- Agent Skills: **per-agent** via Settings > Agent Skills > Configure Agent Skills. Skills added per workspace agent.
  [Source](https://docs.useanything.com/features/agent-configuration/agent-skills)

**Chatbox** (chatboxai/chatbox): MCP support added in **v1.14 (Jan 2026)**. Configured in settings, used in conversations.
[Source](https://docs.chatboxai.app)

**ChatWise**: emerged in 2025, minimal public docs on add flows. Desktop-client with API-key focus; no formal skill/plugin system. **Contributes zero patterns to this report.**

---

## 8. DXT vs MCPB (Import Format Clarification)

Cherry Studio lists both as separate import options. Same format under two name versions:

- **DXT** = Desktop Extensions, original Anthropic name (Jun 2025). [Anthropic announcement](https://www.anthropic.com/news/claude-desktop-extensions)
- **MCPB** = MCP Bundles, renamed/current open-spec form. [modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb): "renamed from DXT to MCPB. Format is spiritually similar to Chrome extensions."
- **Format**: `.mcpb` (or legacy `.dxt`) = ZIP archive + `manifest.json` describing the server + bundled dependencies. One file install = one MCP server. [Credal reference](https://credal.ai/blog/what-is-the-mcp-bundle-format), [mcpbundles.com spec](https://www.mcpbundles.com)

Cherry Studio distinguishes in UI for backward compatibility; functionally identical. **For Momo**: if shipping "drag one file → install MCP server," support `.mcpb` (optionally `.dxt`).

---

## 9. Comparison Table: App × Resource Type × Add Methods

| App | MCP methods | Skill/Plugin methods | Agent methods |
|-----|-------------|----------------------|---------------|
| **Cherry Studio** | (1) Quick-create dialog (name+type+cmd/URL+args), (2) `AddMcpServerModal` JSON paste, (3) DXT file import, (4) MCPB file import, (5) npm scope search one-click (auto-extracts config from README), (6) external marketplace link cards (11 sites), (7) Built-in server list (enable + env), (8) `mcp://` OS-protocol deep link, (9) mcp.json raw edit. Export via Data Settings backup JSON. | (1) `ImportSkillDialog` drag-drop ZIP/directory, (2) `SkillMarketplaceDialog` with 4 sources (skills.sh / claude-plugins.dev / clawhub.ai / GitHub URL), (3) `SystemSkillDialog` discover from agent CLI paths (Claude Code / Codex / Cursor / OpenCode / Copilot / etc.), (4) Builtin skills tab | `ResourceCreateWizard` stepped: Basic Info (avatar+name+runtime+permission+model+desc) → System Prompt → Capability (skills binding) → Knowledge Bases; dynamic step list per agent runtime |
| **Claude Code (CLI)** | `claude mcp add --transport http/sse/ws` + URL + headers; `claude mcp add --transport stdio` + command; `claude mcp add-json` raw JSON; `claude mcp list/get/remove`; `/mcp` panel with status icons | `.claude/skills/<name>/SKILL.md` filesystem; `/plugin marketplace add`; `/plugin install <name>@<marketplace>` | (not its primary surface — agents are claude.ai) |
| **Claude Desktop / claude.ai** | (1) Customize > Connectors > Add custom connector (Name + URL + OAuth), (2) Browse connector catalog | (limited — primarily developer/Code surface) | (chat-based agent creation in claude.ai) |
| **Cline** | (1) Marketplace one-click install, (2) Remote Servers form (Name + URL + Streamable HTTP/SSE dropdown), (3) `~/.cline/mcp.json` edit, (4) `cline mcp` CLI wizard | (1) Marketplace one-click install (Skills tab), (2) Filesystem discovery, (3) Toggle enable without uninstall | (limited — Cline itself is the agent) |
| **Roo Code** | Same as Cline + `.roo/mcp.json` at project root | Same as Cline | n/a |
| **LobeChat** | n/a (OpenAPI-schema plugin only) | (1) `DevModal` left-pane MCPManifestForm + right-pane PluginPreview, (2) OAuth popup flow, (3) Custom plugin install by manifest URL | (1) Built-in agents, (2) Custom agent prompt + model selector |
| **Dify** | n/a | (1) **DSL drag-drop YAML/yml/ifpkg** (full-page hook), (2) URL import, (3) Marketplace template install, (4) 6 plugin types | (1) DSL YAML export/import, (2) Workflow drag-and-drop editor, (3) App template gallery |
| **Coze / 扣子** | n/a | (1) Form-based create plugin + tools, (2) **OpenAPI 3.0 YAML/JSON bulk import**, (3) 3 categories (built-in/custom/commercial) | (1) Form-based bot builder with knowledge + plugin binding, (2) Bot template store |
| **AnythingLLM** | (1) **Edit `anythingllm_mcp_servers.json`** (no UI), (2) Add via Docker volume | Per-agent Skills config; per-workspace scoping | Per-workspace agent with skill binding |
| **Chatbox** | (1) Settings MCP config, (2) JSON-style entry | limited | limited |
| **ChatWise** | none | none | none |

---

## 10. 5 Concrete UX Patterns (with evidence)

### Pattern 1: Discover what's already installed (don't make user re-add)

**Evidence**: Cherry Studio's `SystemSkillDialog` scans Claude Code / Codex / Cursor / OpenCode / Copilot paths and one-click-imports. User's existing skill set becomes available in your app without reinstalling.

[systemSkillSources.ts](https://github.com/CherryHQ/cherry-studio/blob/master/src/main/ai/skills/systemSkillSources.ts#L18-L50)

Cherry Studio's built-in MCP servers (QVeris, etc.) with one-click enable + env key fill.
[McpServerFields isBuiltin](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServerFields.tsx#L296-L320)

Claude Code's `claude mcp list` + `/mcp` panel surfaces already-configured servers with status icons.
[Claude Code docs](https://code.claude.com/docs/en/mcp)

### Pattern 2: Auto-detect from content (don't make user re-type)

**Evidence**: Cherry Studio's `getMcpConfigSampleFromReadme` parses a npm package's README and fills command/args/env on one-click install.
[NpxSearch](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/NpxSearch.tsx#L52-L80)

Dify's `use-dsl-drag-drop` hook makes the entire page a drop target and auto-detects yaml/yml/ifpkg by extension.
[use-dsl-drag-drop](https://github.com/langgenius/dify/blob/main/web/app/components/apps/hooks/use-dsl-drag-drop.ts)

Claude Code auto-detects transport from URL (`https://` → http, `wss://` → ws).
[Claude Code docs](https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server)

### Pattern 3: Type-specific forms over uniform wizards — but accept JSON paste as power-user escape hatch

**Evidence**: Cherry Studio: skill import = drag-drop only, MCP = dropdown menu with 4 choices, Agent = multi-step wizard. Never one uniform form. The JSON-paste path always exists for power users (`AddMcpServerModal`, `mcp.json` direct edit).

Cline: same code path for all 3 types BUT type-specific rendering (MCP gets server-list management panel, Skills get filesystem rows). The "uniform shell, type-aware contents" pattern.
[MarketplaceView](https://github.com/cline/cline/blob/master/apps/vscode/webview-ui/src/components/marketplace/MarketplaceView.tsx#L48-L100)

Dify: DSL YAML for apps, plugin marketplace for plugins, workflow editor for agents. Three totally different surfaces.

### Pattern 4: Inline validation + per-row status feedback

**Evidence**: Cherry Studio's MCP dialog: duplicate name check on submit, required-field validation (`baseUrl` for sse, `command` for stdio).
[buildMcpSchema](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServerFields.tsx#L21-L45)

Cherry Studio's skill import: per-item status icon (pending / installing / success / error) in results list, partial-failure messaging.
[ImportSkillDialog](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/skill/ImportSkillDialog.tsx#L155-L180)

Claude Code's `/mcp`: `✔ Connected` / `! Needs authentication` / `✘ Failed to connect` / `⏸ Pending approval` per server — you never wonder if it worked.
[Claude Code docs](https://code.claude.com/docs/en/mcp)

Cline's `McpManagementPanel` shows org-managed servers with a lock icon callout. Friendly.

### Pattern 5: Curated external links over fake internal marketplaces

**Evidence**: Cherry Studio's `McpMarketList`: 11 cards each opening the real marketplace in browser. Honest "we don't host, but here are the best places."
[McpMarketList](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpMarketList.tsx#L21-L100)

This is friendlier than a half-empty internal catalog. Discovery is delegated, trust is delegated.

Cherry Studio's SkillMarketplaceDialog does the opposite for skills: 4 actual sources with live search (skills.sh, claude-plugins.dev, clawhub.ai) because SKILL.md is small and indexable. Type-dependent decision.

---

## 11. Momo Studio Recommendations

**Do NOT adopt a uniform 3-path "create" wizard.** Adopt **type-specific add surfaces** that match what each artifact type actually is.

### 11a. Agent (YAML)

- **Primary path**: 4-step wizard (基本/人格/技能/知识库) like Cherry Studio's ResourceCreateWizard. Multi-section YAML with per-section validation gates.
- **Secondary paths**:
  - Drag-drop a `.yaml` file directly into the library (Dify pattern)
  - "From workspace member" — clone an existing agent's YAML as starting point
- **Source discovery**: scan `electron/resources/agents/*.yaml` and list as "Built-in" (already in repo per AGENTS.md).

### 11b. MCP (command or URL)

- **Primary path**: dropdown menu with 4 explicit choices, NOT one big dialog:
  - 手动添加 (form: name + type select [stdio/sse/streamableHttp] + command-or-URL + args + env + timeout)
  - 从 JSON 导入 (paste mcpServers JSON block)
  - 从 npm 安装 (one-click: search npm scope, auto-parse config from README like Cherry Studio NpxSearch)
  - 从市场安装 (marketplace one-click install)
- **Secondary path**: external marketplace link cards (Cherry Studio's `McpMarketList` pattern) since MCP ecosystem is still fragmented.
- **Per-server enable toggle + status badge** (disabled / connecting / connected / error). Cherry Studio MCP runtime status pattern.
- **Optional**: support `.mcpb` (and `.dxt`) one-file install — real, growing packaging format with formal spec.

### 11c. Skill (SKILL.md)

- **Primary path**: drag-drop a folder or ZIP into the library (Cherry Studio `ImportSkillDialog` pattern).
- **Secondary paths** (separate dialogs, not a unified menu):
  - 从市场安装 (marketplace: search SKILL.md registries, GitHub URL, npm scope)
  - 从系统发现 (scan `~/.claude/skills/`, `~/.codex/skills/`, etc. and one-click import — Cherry Studio SystemSkillDialog pattern)
  - 从内置导入 (list `electron/resources/skills/*.md`)
- **Per-skill enable toggle** + conflict detection (same skill name from two CLI sources → Conflict button).

### 11d. Cross-cutting (all 3 types)

- **Tone**: "Discover what you have, then add what's new" — leading with built-in/system detection, then add new.
- **Search/filter across all 3**: consistent location filter dropdown (all / builtin / system / custom / p2p).
- **One-click toggle enable/disable** for all 3 resource types — never make user delete+re-add.
- **Per-resource status badge** for MCP (runtime) or last-updated timestamp for skills/agents.
- **Drop any YAML/SKILL.md file anywhere on the page** (Dify full-page drag-drop) — not just in a tiny drop zone.

### 11e. Specifically AVOID

- A single "Resource Create Wizard" for all three types — only Cherry Studio does this, and only for assistant+agent (not MCP/skill).
- Empty "coming soon" marketplace — Cherry Studio's honest external-link-cards is better than a fake internal one.
- Hiding the JSON paste path behind a separate "Advanced" toggle — keep it in the "+" dropdown so power users don't dig.

---

## 12. Appendix: All Source Citations

### Cherry Studio source files (master branch via zread.ai)
- [McpSettings.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpSettings.tsx)
- [McpServersList.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServersList.tsx)
- [McpServerFields.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpServerFields.tsx)
- [QuickCreateMcpServerDialog.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/QuickCreateMcpServerDialog.tsx)
- [McpMarketList.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/McpMarketList.tsx)
- [NpxSearch.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/McpSettings/NpxSearch.tsx)
- [SkillsSettings.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/settings/SkillsSettings.tsx)
- [AgentCreateDialog.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/pages/agents/components/AgentCreateDialog.tsx)
- [ResourceCreateWizard.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/create/ResourceCreateWizard.tsx)
- [BasicInfoStep.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/create/steps/BasicInfoStep.tsx)
- [types.ts (Create Wizard)](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/create/types.ts)
- [ImportSkillDialog.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/skill/ImportSkillDialog.tsx)
- [SkillMarketplaceDialog.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/skill/SkillMarketplaceDialog.tsx)
- [SystemSkillDialog.tsx](https://github.com/CherryHQ/cherry-studio/blob/master/src/renderer/components/resourceCatalog/dialogs/skill/SystemSkillDialog.tsx)
- [SkillInstaller.ts](https://github.com/CherryHQ/cherry-studio/blob/master/src/main/ai/skills/SkillInstaller.ts)
- [systemSkillSources.ts](https://github.com/CherryHQ/cherry-studio/blob/master/src/main/ai/skills/systemSkillSources.ts)

### Other apps
- [Cline MarketplaceView.tsx](https://github.com/cline/cline/blob/master/apps/vscode/webview-ui/src/components/marketplace/MarketplaceView.tsx)
- [LobeChat DevModal](https://github.com/lobehub/lobe-chat/blob/main/src/features/PluginDevModal/index.tsx)
- [Dify use-dsl-drag-drop](https://github.com/langgenius/dify/blob/main/web/app/components/apps/hooks/use-dsl-drag-drop.ts)
- [modelcontextprotocol/mcpb spec](https://github.com/modelcontextprotocol/mcpb)

### Official docs
- [Cline MCP Marketplace docs](https://docs.cline.bot/mcp/mcp-marketplace)
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [Claude Skills docs](https://code.claude.com/docs/en/skills)
- [Claude custom connectors docs](https://support.claude.com/en/articles/get-started-with-custom-connectors-using-remote-mcp)
- [Anthropic Desktop Extensions announcement](https://www.anthropic.com/news/claude-desktop-extensions)
- [Dify App Management docs](https://docs.dify.ai/en/cloud/use-dify/workspace/app-management)
- [Dify Plugin docs](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type)
- [Coze plugin docs](https://docs.coze.cn)
- [Coze Studio wiki](https://github.com/coze-dev/coze-studio/wiki/4.-插件配置)
- [AnythingLLM MCP docs](https://docs.useanything.com)
- [Chatbox MCP docs](https://docs.chatboxai.app)
- [Cherry Studio docs](https://docs.cherryai.com.cn)
- [mcpbundles.com spec reference](https://www.mcpbundles.com)
- [Credal MCPB format reference](https://credal.ai/blog/what-is-the-mcp-bundle-format)
