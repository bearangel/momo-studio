// 本地模块声明：@types/mammoth 在 npm 不存在（404），mammoth 1.x 无自带类型。
// 仅声明本仓库消费的最小面（office/docx.ts 的 convertToMarkdown）。
declare module 'mammoth' {
  export interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export function convertToMarkdown(
    input: { path?: string; buffer?: Buffer },
    options?: Record<string, unknown>,
  ): Promise<MammothResult>;
}
