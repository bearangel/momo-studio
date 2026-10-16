// codegraph 索引引擎类型面（供宿主测试消费；与 indexer.js 实现同形）
export interface IndexerDef {
  file: string;
  line: number;
  kind: string;
  snippet: string;
}
export interface ExploreResult {
  symbol: string;
  definition: IndexerDef;
  callers: { file: string; lines: number[] }[];
  blastRadius: string[];
  approximate: true;
}
export interface GraphResult {
  nodes: { id: string; kind: string }[];
  edges: { from: string; to: string }[];
  stats: { files: number; symbols: number; edges: number; lastIndexedAt: number };
}
export function createIndexer(opts: { root: string; maxFiles?: number }): {
  scanFull(): { files: number; symbols: number; edges: number };
  scanFile(abs: string): void;
  explore(symbol: string): ExploreResult | null;
  graph(symbol?: string, limit?: number): GraphResult;
};
