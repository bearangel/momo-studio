// renderer/src/components/ui/emoji-presets.ts
//
// EmojiPicker 预设数据（2026-10-11 P1 预览批准稿）：6 分类 × 16 = 96 个精选 emoji。
// - emoji 是用户数据（DB icon_emoji 列 / AgentDefinition.iconEmoji 的候选值），
//   非 UI 图标——豁免「禁 emoji 图标」规则（先例：CreateAgentDialog useState('🤖')）
// - 以单码点为主保证三平台渲染；少量 ZWJ 序列（👩‍💻 等）对齐既有数据先例
// - 收录即冻结：增删改属视觉变更，走 momo-ui-preview-rules 重新预览确认
export interface EmojiCategory {
  /** 分类稳定 key（tab 切换状态用，勿复用） */
  key: string;
  /** 分类 tab 显示名 */
  label: string;
  /** 该分类 emoji（全局唯一、非空——EmojiPicker.test.tsx 数据完整性用例锁定） */
  emojis: string[];
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    key: 'smileys',
    label: '笑脸',
    emojis: ['😀', '😃', '😄', '😅', '😂', '🙂', '😉', '😊', '😎', '🤓', '🧐', '😮', '🤔', '😴', '🥳', '😇'],
  },
  {
    key: 'roles',
    label: '角色',
    emojis: ['🤖', '👻', '🦸', '🥷', '🧙', '🕵️', '👮', '👑', '🎩', '🧢', '👓', '🦰', '👩‍💻', '🧑‍🔬', '🧑‍🎨', '🧑‍🚀'],
  },
  {
    key: 'animals',
    label: '动物',
    emojis: ['🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🦉', '🦄', '🐙', '🦋'],
  },
  {
    key: 'objects',
    label: '物品',
    emojis: ['💻', '🖥️', '⌨️', '🔧', '🔨', '⚙️', '🔬', '🔭', '🧰', '🎨', '🎮', '📷', '🔑', '💡', '🧲', '📦'],
  },
  {
    key: 'nature',
    label: '自然',
    emojis: ['🌈', '⭐', '🌙', '☀️', '⚡', '🔥', '💧', '🌊', '🌸', '🌲', '🍀', '🍁', '🌍', '❄️', '🌪️', '🌻'],
  },
  {
    key: 'office',
    label: '办公',
    emojis: ['📋', '📝', '📁', '📂', '📊', '📈', '📉', '📌', '📎', '🗂️', '💼', '🗓️', '✅', '🎯', '🚀', '🏆'],
  },
];

// 缺省分类（首项）——noUncheckedIndexedAccess 下 [0] 索引的类型收窄出口；
// 空配置属数据错误，模块加载即失败（数据完整性另有测试用例锁定）
const firstCategory = EMOJI_CATEGORIES[0];
if (!firstCategory) throw new Error('emoji-presets 配置错误：EMOJI_CATEGORIES 不能为空');
export const DEFAULT_CATEGORY: EmojiCategory = firstCategory;
