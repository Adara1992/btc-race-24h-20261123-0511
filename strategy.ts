// Momentum strategy for CBBTC (cbBTC/USDC, 1-minute bars).
// Pure logic, no IO, fully deterministic: every decision is a function of the
// bars seen so far. main.ts wires this to the bars-replay protocol; the offline
// backtester imports this same module, so the tested strategy IS the shipped one.
//
// Idea: 1-minute noise (mean ~5 bps) is far below the ~26 bps full-size round-trip
// cost, so 1-minute trading is hopeless. The money is in multi-hour moves: enter
// when the trailing W-minute return exceeds a threshold, hold with a trailing stop
// from the peak close, at most N entries per window. No EMA filter (tested: worse).

export const SYMBOL = "CBBTC";

export interface MomentumConfig {
  /** Lookback for the entry trigger, in minutes. */
  windowMin: number;
  /** Trailing W-minute return must strictly exceed this, in bps. */
  entryBps: number;
  /** Trailing stop from the peak close since entry, in bps. */
  trailBps: number;
  /** Max filled buys per window. */
  maxEntries: number;
  /** Fraction of cash spent per entry, in bps (10000 = all cash). */
  entryFractionBps: number;
  /** Take profit above the entry fill price, in bps (0 = none). */
  takeProfitBps: number;
  /** Once the position is this far above the entry fill price (bps, 0 = never),
   *  tighten the trailing stop to trailTightBps. */
  trailTightAtBps: number;
  /** Tightened trailing stop distance, in bps. */
  trailTightBps: number;
  /** Entry mode: "momentum" (trailing return above entryBps), "dip" (trailing
   *  return below -dipBps, i.e. buy weakness), or "hybrid" (either trigger). */
  entryMode: "momentum" | "dip" | "hybrid";
  /** Dip trigger: trailing dipWindowMin return below -dipBps, in bps. */
  dipBps: number;
  /** Lookback for the dip trigger, in minutes. */
  dipWindowMin: number;
  /** Recovery confirmation for a dip entry: trailing recoveryWindowMin return
   *  must exceed this, in bps (0 = no confirmation). */
  recoveryBps: number;
  /** Lookback for the recovery confirmation, in minutes. */
  recoveryWindowMin: number;
  /** Longer lookback that must also be rising, in minutes (0 = none). */
  longWindowMin: number;
  /** Required long-window return, in bps. */
  longTrendBps: number;
  /** Scale in while holding: if the trigger fires again, spend the remaining
   *  cash (the first entry spends entryFractionBps of cash). */
  pyramid: boolean;
  /** Do not enter in the last N minutes of the window (0 = no guard). */
  noEntryLastMin: number;
  /** Total bars in the window (1440 for a 24h window), for the no-entry guard. */
  totalBars: number;
  /** Max slippage vs the latest close allowed on any order, in bps. */
  maxSlippageBps: number;
}

export const DEFAULT_CONFIG: MomentumConfig = {
  windowMin: 60,
  entryBps: 40,
  trailBps: 250,
  maxEntries: 2,
  entryFractionBps: 10000,
  takeProfitBps: 0,
  trailTightAtBps: 0,
  trailTightBps: 0,
  entryMode: "momentum",
  dipBps: 40,
  dipWindowMin: 60,
  recoveryBps: 0,
  recoveryWindowMin: 15,
  longWindowMin: 0,
  longTrendBps: 0,
  pyramid: false,
  noEntryLastMin: 0,
  totalBars: 1440,
  maxSlippageBps: 100,
};

export type Decision =
  | { side: "buy"; notional: bigint }
  | { side: "sell"; qty: bigint };

export class MomentumBot {
  readonly cfg: MomentumConfig;
  /** Filled buys so far this window. */
  entries = 0;
  private closes: Array<{ t: number; close: bigint }> = [];
  private peak: bigint | null = null;
  private entryPrice: bigint | null = null;

  constructor(cfg: MomentumConfig) {
    this.cfg = cfg;
  }

  /** Record a bar's close. Call once per bar, before decide(). */
  onClose(t: number, close: bigint): void {
    this.closes.push({ t, close });
    // Keep only what the longest lookback needs (plus margin).
    const horizon = Math.max(this.cfg.windowMin, this.cfg.longWindowMin, 60) + 5;
    const cutoff = t - horizon * 60_000;
    while (this.closes.length > 0 && this.closes[0]!.t < cutoff) this.closes.shift();
  }

  /** The latest close recorded, or null before the first bar. */
  latestClose(): bigint | null {
    const n = this.closes.length;
    return n === 0 ? null : this.closes[n - 1]!.close;
  }

  /** Number of bars seen so far. */
  barsSeen(): number {
    return this.closes.length;
  }

  /** A buy filled at this price (the next bar's open). The peak and entry price
   *  anchor to the FIRST entry; a pyramid add does not reset them. */
  noteFillBuy(price: bigint): void {
    this.entries++;
    if (this.peak === null) {
      this.entryPrice = price;
      this.peak = price;
    }
  }

  /** The position was sold (trailing stop / take profit / flatten). */
  noteFillSell(): void {
    this.peak = null;
    this.entryPrice = null;
  }

  /** Close at or before time t, or null when no bar that old is recorded. */
  private closeAtOrBefore(t: number): bigint | null {
    for (let i = this.closes.length - 1; i >= 0; i--) {
      if (this.closes[i]!.t <= t) return this.closes[i]!.close;
    }
    return null;
  }

  private retBps(now: bigint, then: bigint): bigint {
    return ((now - then) * 10_000n) / then;
  }

  /** The entry trigger: trailing windowMin return above entryBps (plus the
   *  long-window filter when configured). */
  private triggerFires(close: bigint): boolean {
    const cfg = this.cfg;
    const tNow = this.closes[this.closes.length - 1]!.t;
    if (cfg.entryMode === "momentum" || cfg.entryMode === "hybrid") {
      const old = this.closeAtOrBefore(tNow - cfg.windowMin * 60_000);
      if (old !== null && this.retBps(close, old) > BigInt(cfg.entryBps)) {
        let ok = true;
        if (cfg.longWindowMin > 0) {
          const oldLong = this.closeAtOrBefore(tNow - cfg.longWindowMin * 60_000);
          if (oldLong === null || this.retBps(close, oldLong) <= BigInt(cfg.longTrendBps)) ok = false;
        }
        if (ok) return true;
      }
    }
    if (cfg.entryMode === "dip" || cfg.entryMode === "hybrid") {
      const oldDip = this.closeAtOrBefore(tNow - cfg.dipWindowMin * 60_000);
      if (oldDip === null) return false;
      if (this.retBps(close, oldDip) >= -BigInt(cfg.dipBps)) return false;
      if (cfg.recoveryBps > 0) {
        const oldRec = this.closeAtOrBefore(tNow - cfg.recoveryWindowMin * 60_000);
        if (oldRec === null) return false;
        if (this.retBps(close, oldRec) <= BigInt(cfg.recoveryBps)) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Decide this bar's orders. `cash` is the cash on hand, `qty` the position held.
   * Call after onClose() for the bar, and after noting any fills reported with it.
   * `seq` is the 0-based batch index (for the no-entry guard).
   */
  decide(cash: bigint, qty: bigint, seq: number): Decision[] {
    const close = this.latestClose();
    if (close === null) return [];
    const cfg = this.cfg;

    if (qty > 0n) {
      // Holding: maintain the trailing stop from the peak close.
      if (this.peak === null) this.peak = close;
      if (close > this.peak) this.peak = close;
      // Once deep in profit, tighten the stop so a reversal locks in more.
      let trail = cfg.trailBps;
      if (
        cfg.trailTightAtBps > 0 &&
        this.entryPrice !== null &&
        this.retBps(close, this.entryPrice) >= BigInt(cfg.trailTightAtBps)
      ) {
        trail = cfg.trailTightBps;
      }
      if (((this.peak - close) * 10_000n) / this.peak >= BigInt(trail)) {
        return [{ side: "sell", qty }];
      }
      if (
        cfg.takeProfitBps > 0 &&
        this.entryPrice !== null &&
        this.retBps(close, this.entryPrice) >= BigInt(cfg.takeProfitBps)
      ) {
        return [{ side: "sell", qty }];
      }
      // Scale in: the trend is still running, add the remaining cash.
      if (cfg.pyramid && this.entries < cfg.maxEntries && this.triggerFires(close)) {
        if (cash >= 1_000_000n) return [{ side: "buy", notional: cash }];
      }
      return [];
    }

    // Flat: consider entering.
    if (this.entries >= cfg.maxEntries) return [];
    if (cfg.noEntryLastMin > 0 && seq >= cfg.totalBars - cfg.noEntryLastMin) return [];
    if (!this.triggerFires(close)) return [];
    const notional = (cash * BigInt(cfg.entryFractionBps)) / 10_000n;
    if (notional < 1_000_000n) return []; // below the 1 USDC minimum
    return [{ side: "buy", notional }];
  }
}
