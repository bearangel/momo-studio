// electron/src/main/skill/types.ts
//
// Skill 相关类型定义。一个 skill 是一个可被 agent 引用的能力包，物理形态是
// 一个目录（含 SKILL.md 正文 + 可选附加资源文件），通过 SkillRegistry 注册后
// 供 agent 运行时按需加载。

/** SKILL.md 的 YAML frontmatter（--- 包围段） */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
  /** 该 skill 允许调用的工具白名单（留空表示不限制） */
  allowedTools?: string[];
  /** 标签，用于分类与检索 */
  tags?: string[];
}

/** 完整 skill 定义（frontmatter 解析结果 + 运行时元数据） */
export interface SkillDefinition extends SkillFrontmatter {
  id: string;
  /** 注册时由 name 派生的唯一标识（用作 SkillRegistry 的 key 与 LLM 调用 slug） */
  slug: string;
  /** skill 包在磁盘上的绝对路径（读取附加资源时作为基准目录） */
  cachePath: string;
  /** Markdown 正文（不含 frontmatter），即 loadFull 返回的内容 */
  body: string;
}
