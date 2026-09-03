// renderer/tailwind.config.d.ts
// tailwind.config.js 的类型声明：repo 为 strict 且未开 allowJs，
// tokens.test.ts 等直接导入 `../../tailwind.config.js` 会触发 TS7016（隐式 any）。
// 只声明被消费的字段（theme.colors）；新增 token 组时同步扩展此接口。
interface ColorGroup {
  [key: string]: string;
}

export interface TailwindConfig {
  content: string[];
  darkMode: 'class';
  theme: {
    /** P4 起独占定义（无 extend）：完全替换 Tailwind 默认色阶 */
    colors: {
      transparent: string;
      current: string;
      canvas: string;
      surface: ColorGroup;
      primary: string;
      secondary: string;
      tertiary: string;
      disabled: string;
      inverse: string;
      subtle: string;
      strong: string;
      focus: string;
      accent: ColorGroup;
      status: ColorGroup;
      backdrop: string;
    };
  };
}

declare const config: TailwindConfig;

export default config;
