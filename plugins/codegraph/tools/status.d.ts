export function createTools(ctx: unknown): {
  getDefs(): { name: string; description: string; inputSchema: unknown }[];
  getCatalog(): { name: string }[];
  handles(name: string): boolean;
  execute(name: string, args: unknown): Promise<unknown>;
};
