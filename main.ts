// BTC race bot: 60-minute momentum with a trailing stop.
//
// Strategy (chosen by offline backtest with the harness's exact fill model, over
// the dev window plus five synthetic windows: mirrored-down, flattened, mirrored
// +flattened, steepened rally, time-reversed):
//   - Enter when the trailing 60-minute return exceeds +40 bps, full cash.
//   - Hold with a 250 bps trailing stop from the peak close.
//   - Once +300 bps in profit, tighten the stop to 150 bps from the peak.
//   - At most 2 entries per window (a second entry only after the first stops out).
//   - 1-minute noise (~5 bps) is far below the ~26 bps round-trip cost, so the bot
//     only trades multi-hour moves and usually sits out flat stretches.
// Backtest (exact model): dev +32.2 USDC, down -8.7, flat +0.7, down-flat 0.0,
// steep rally +52.0, reversed -25.1; dev max drawdown 197 bps (limit 2500 bps).
// The house bots on dev: ema-cross -862 bps, momentum -192 bps, buy-and-hold +336 bps.

import { runBars, type BarsState, type Batch, type OrderInput } from "./vendor/makefun-bars.ts";
import { MomentumBot, DEFAULT_CONFIG, SYMBOL } from "./strategy.ts";

const bot = new MomentumBot({
  ...DEFAULT_CONFIG,
  windowMin: 60,
  entryBps: 40,
  trailBps: 250,
  maxEntries: 2,
  entryFractionBps: 10000,
  takeProfitBps: 0,
  longWindowMin: 0,
  longTrendBps: 0,
  pyramid: false,
  noEntryLastMin: 0,
  totalBars: 1440,
  maxSlippageBps: 100,
  trailTightAtBps: 300,
  trailTightBps: 150,
});

// The t of the last bar recorded, so a batch with no new CBBTC bar (a gap
// minute) does not record the same close twice.
let lastT = -1;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Note the fills reported with this batch: orders decided on the previous
    // bar, filled at this bar's open. Only filled orders count as entries.
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL || f.status !== "filled") continue;
      if (f.side === "buy") bot.noteFillBuy(BigInt(f.price));
      else bot.noteFillSell();
    }
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    if (bar.t !== lastT) {
      bot.onClose(bar.t, BigInt(bar.c));
      lastT = bar.t;
    }
    // Warm-up batches build history only; any order decided on one is rejected.
    if (state.warmingUp) return [];
    const pos = state.positions.get(SYMBOL);
    const qty = pos === undefined ? 0n : BigInt(pos.qty);
    const decisions = bot.decide(state.cash, qty, state.seq);
    return decisions.map((d): OrderInput =>
      d.side === "buy"
        ? { side: "buy", symbol: SYMBOL, notional_quote_units: d.notional, max_slippage_bps: bot.cfg.maxSlippageBps }
        : { side: "sell", symbol: SYMBOL, qty: d.qty, max_slippage_bps: bot.cfg.maxSlippageBps },
    );
  },
});
