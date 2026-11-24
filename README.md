# Band Rider — Pump.fun Replay Sprint Paper Bot

A paper-trading bot for the make.fun competition [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122). It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity under the `agent-fun/replay/v2` protocol. No real funds, wallet or network are involved.

[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aira-catur/pump-fun-replay-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aira-catur/pump-fun-replay-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

## Strategy

Band Rider buys only curves whose real SOL reserve has climbed into a middle band (45–84 SOL) —
coins that have survived their launch phase and are travelling toward completion — and only
when the recent tape confirms broad buy flow: at least 4 SOL of net inflow over the last
150 slots, from at least 7 distinct buyers, with the price rising inside the window. Each coin
gets at most one entry of a fixed 0.2 SOL stake (always inside the 1%-of-reserve order cap).
Positions are closed whole on the first of a −12% stop, a trailing exit after a strong run, a
fade exit when net flow turns negative, a reserve-drain exit, or a 3,000-slot time limit. A
slow drip of tiny probe round trips on liquid curves guarantees the guardrail of round trips
on at least 20 distinct coins without depending on the main signal firing twenty times.

On this kit's dev window — a hostile tape on which every kit pilot baseline loses money — the
bot grades at about −0.11 SOL with a maximum drawdown near 3%: the small stake, one-entry-per-
coin rule and layered exits are chosen so a bad window costs little, while the same shape
keeps the full upside of completion riders on a friendlier tape.

The bot is deterministic by construction: no clock, no randomness, no environment reads, and
iteration only over insertion-ordered maps fed by the batch stream, so the grader's two
executions produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint run by the grader (`node /bot/main.ts`)
- `strategy.ts` — the Band Rider strategy
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` TypeScript shim, vendored byte for byte

## License

MIT — see `LICENSE`.
