# BTC Race Bot — 24h Momentum

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Adara1992/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Adara1992/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/competitions/btc-race-24h-20261123-0511)

A trading bot for the [make.fun BTC race](https://make.fun/competitions/btc-race-24h-20261123-0511)
(`btc-race-24h-20261123-0511`): it trades cbBTC/USDC on a 24-hour replay of
1-minute bars, long only, starting from 1,000 USDC paper.

## Strategy

- **Enter** when the return of the last 60 minutes exceeds +40 bps, using the
  full cash balance (at most 2 entries).
- **Hold** with a two-tier trailing stop: 250 bps from the highest price
  reached, tightened to 150 bps once the position is up +300 bps.
- No take-profit and no time limit, so winners run until the trend really
  turns. No EMA/trend filter, no pyramiding — every variant was backtested
  and performed worse.
- Fully deterministic: integer arithmetic only, no wall clock, no network,
  no randomness.

## Result (dev window, grade-local)

Net PnL **+32.24 USDC (+3.22%)**, 1 trade, win rate 100%, max drawdown
1.98% (limit 25%). The dev gate requires net PnL > 0, so this bot qualifies
to race.

## Files

- `main.ts` — the bot entrypoint (Node 22, erasable TypeScript).
- `strategy.ts` — the pure strategy logic, shared with the backtester.
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim, as
  the competition requires.
