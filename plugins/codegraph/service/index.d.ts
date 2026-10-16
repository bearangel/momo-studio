// codegraph service 类型面（供宿主测试消费）
export interface PluginServiceCtx {
  getConfig(): Record<string, unknown>;
  getDataDir(): string;
  logger: { info(msg?: unknown, meta?: unknown): void; warn(msg?: unknown, meta?: unknown): void; error(msg?: unknown, meta?: unknown): void };
}
export interface GraphService {
  start(): Promise<void>;
  stop(): Promise<void>;
  handle(method: string, params: unknown): Promise<unknown>;
}
export function createService(ctx: PluginServiceCtx): GraphService;
