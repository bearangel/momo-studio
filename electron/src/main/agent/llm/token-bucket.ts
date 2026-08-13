// electron/src/main/agent/llm/token-bucket.ts
//
// Provider 令牌桶——每个 model_provider 一个实例。
// 滑动窗口算法：记录每次请求的时间戳 + token 数，
// canConsume 时过滤掉超出窗口的记录，再判断余量。
//
// 性能：典型场景每 provider 每分钟 < 100 请求，filter 开销可忽略。
// 不依赖 Date.now()（用内部虚拟时钟，便于测试）。

export interface TokenBucketOpts {
  maxRpm?: number;   // NULL = 不限 RPM
  maxTpm?: number;   // NULL = 不限 TPM
  windowMs?: number; // 默认 60_000（1 分钟）
}

interface TokenLogEntry {
  ts: number;
  tokens: number;
}

export class ProviderTokenBucket {
  private readonly maxRpm?: number;
  private readonly maxTpm?: number;
  private readonly windowMs: number;
  private rpmLog: number[] = [];      // 请求时间戳
  private tokenLog: TokenLogEntry[] = [];
  private virtualNow: number;

  constructor(opts: TokenBucketOpts) {
    this.maxRpm = opts.maxRpm;
    this.maxTpm = opts.maxTpm;
    this.windowMs = opts.windowMs ?? 60_000;
    this.virtualNow = Date.now();
  }

  canConsume(estimatedTokens: number = 1000): boolean {
    this.gc();
    const rpmOk = !this.maxRpm || this.rpmLog.length < this.maxRpm;
    const currentTpm = this.tokenLog.reduce((sum, e) => sum + e.tokens, 0);
    const tpmOk = !this.maxTpm || currentTpm + estimatedTokens <= this.maxTpm;
    return rpmOk && tpmOk;
  }

  record(actualTokens: number): void {
    this.gc();
    this.rpmLog.push(this.virtualNow);
    this.tokenLog.push({ ts: this.virtualNow, tokens: actualTokens });
  }

  getRpmUsage(): number {
    this.gc();
    return this.rpmLog.length;
  }

  getTpmUsage(): number {
    this.gc();
    return this.tokenLog.reduce((sum, e) => sum + e.tokens, 0);
  }

  private gc(): void {
    const cutoff = this.virtualNow - this.windowMs;
    this.rpmLog = this.rpmLog.filter((ts) => ts > cutoff);
    this.tokenLog = this.tokenLog.filter((e) => e.ts > cutoff);
  }

  /** 测试用：快进时间 */
  __advanceTime(ms: number): void {
    this.virtualNow += ms;
  }
}
