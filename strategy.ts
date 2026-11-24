// Band Rider strategy for the pump.fun replay sprint (agent-fun/replay/v2).
//
// Idea: a bonding curve that has already absorbed real demand is a different animal from a fresh
// launch. Once a curve's real SOL reserve climbs into a middle band, the coin has survived its
// bundled-launch phase and is on the road toward completion; the remaining upside to graduation is
// still large, while the weakest hands have usually already sold. This bot only buys inside that
// band, and only when the recent tape confirms the climb is driven by broad, accelerating buy flow
// rather than one wallet shoving the price up.
//
// Position shape: one fixed stake per entry, no pyramiding. The position is closed whole on the
// first of: a hard stop under cost, a trailing exit after a strong run, a fade exit when the tape's
// net flow turns negative, or a slot time limit. A curve that completes is closed by the replay
// itself at its final reserves.
//
// Guardrail probes: the competition requires round trips of at least 0.01 SOL on at least 20
// distinct coins. The main signal may not touch 20 coins on a quiet window, so the bot keeps a
// slow drip of tiny probe round trips (buy a liquid curve, sell it as soon as the fill lands)
// until 20 distinct coins have completed a round trip. Probes never share a slot with a main
// position in the same coin and never take the last position slot.
//
// Robustness: the stake is deliberately modest and the entry needs the reserve band plus flow
// confirmation, so a window that truncates coin lifecycles early (the failure mode of aggressive
// completion riding) hurts less: stops and the time limit cut losers quickly, and probes finish
// early in the run instead of depending on late-window coins.
//
// Determinism: no clock, no randomness, no environment reads; iteration is only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000;

export interface Params {
  bandLoSol: number;
  bandHiSol: number;
  flowWindowSlots: number;
  minNetInflowSol: number;
  minBuyTrades: number;
  minDistinctBuyers: number;
  minPriceRise: number;
  maxPriceRise: number;
  minAgeSlots: number;
  stakeSol: number;
  buySlippageBps: number;
  stopLossFrac: number;
  trailArmFrac: number;
  trailDropFrac: number;
  fadeWindowSlots: number;
  fadeNetOutflowSol: number;
  /** Exit when the curve's real reserve falls this fraction below its peak since entry. */
  reserveDropFrac: number;
  maxHoldSlots: number;
  reentryCooldownSlots: number;
  maxEntriesPerCurve: number;
  maxMainPositions: number;
  maxExposureSol: number;
  probeSol: number;
  probeEverySlots: number;
  probeTargetCoins: number;
  probeBandLoSol: number;
  probeBandHiSol: number;
}

export const PARAMS: Params = {
  bandLoSol: 45,
  bandHiSol: 84,
  flowWindowSlots: 150,
  minNetInflowSol: 3,
  minBuyTrades: 6,
  minDistinctBuyers: 5,
  minPriceRise: 0.03,
  maxPriceRise: 0.9,
  minAgeSlots: 200,
  stakeSol: 0.2,
  buySlippageBps: 1500,
  stopLossFrac: 0.12,
  trailArmFrac: 0.18,
  trailDropFrac: 0.1,
  fadeWindowSlots: 100,
  fadeNetOutflowSol: 1.5,
  reserveDropFrac: 0.18,
  maxHoldSlots: 3000,
  reentryCooldownSlots: 4000,
  maxEntriesPerCurve: 1,
  maxMainPositions: 4,
  maxExposureSol: 2.2,
  probeSol: 0.03,
  probeEverySlots: 1200,
  probeTargetCoins: 20,
  probeBandLoSol: 15,
  probeBandHiSol: 120,
};

interface TapeEntry {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTrack {
  tape: TapeEntry[];
  entries: number;
  lastExitSlot: number;
}

interface OpenPos {
  kind: 'main' | 'probe';
  entrySlot: number;
  peakValueSol: number;
  peakReserveSol: number;
  sellPending: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  const t = Number(vt);
  if (t <= 0) return 0;
  return Number(vq) / t;
}

// SOL the curve would pay for `tokens` right now, on its virtual reserves (constant product).
function sellQuoteSol(tokens: bigint, vq: bigint, vt: bigint): number {
  const t = Number(tokens);
  if (t <= 0) return 0;
  const q = Number(vq);
  const v = Number(vt);
  if (v + t <= 0) return 0;
  return q * (t / (v + t)) / SOL;
}

export function createBot(p: Params = PARAMS): Bot {
  const tracks = new Map<Pubkey, CurveTrack>();
  const open = new Map<Pubkey, OpenPos>();
  const intentByMint = new Map<Pubkey, 'main' | 'probe'>();
  const roundTripped = new Set<Pubkey>();
  const boughtMints = new Set<Pubkey>();
  let lastProbeSlot = -1_000_000;
  let firstSlot = -1;

  function track(mint: Pubkey): CurveTrack {
    let t = tracks.get(mint);
    if (t === undefined) {
      t = { tape: [], entries: 0, lastExitSlot: -1_000_000 };
      tracks.set(mint, t);
    }
    return t;
  }

  // Net flow, buy count, distinct buyers and price change over the last `window` slots of tape.
  function flowStats(t: CurveTrack, nowSlot: number, window: number) {
    let net = 0;
    let buys = 0;
    const buyers = new Set<string>();
    let firstPrice = 0;
    let lastPrice = 0;
    for (const e of t.tape) {
      if (e.slot < nowSlot - window) continue;
      if (firstPrice === 0) firstPrice = e.price;
      lastPrice = e.price;
      if (e.buy) {
        net += e.sol;
        buys += 1;
        buyers.add(e.user);
      } else {
        net -= e.sol;
      }
    }
    return { net, buys, buyers: buyers.size, rise: firstPrice > 0 ? lastPrice / firstPrice - 1 : 0 };
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    if (firstSlot < 0) firstSlot = slot;

    // 1. Fold this batch's fills into the round-trip ledger.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy' && Number(f.quote_lamports) >= 10_000_000) boughtMints.add(f.mint);
      if (f.side === 'sell' && boughtMints.has(f.mint)) roundTripped.add(f.mint);
      const pos = open.get(f.mint);
      if (f.side === 'sell' && pos !== undefined && pos.sellPending) {
        open.delete(f.mint);
        const t = track(f.mint);
        t.lastExitSlot = slot;
      }
    }

    // 2. Fold events into per-curve tapes; remember which curves were touched.
    const touched = new Set<Pubkey>();
    const keepFrom = slot - Math.max(p.flowWindowSlots, p.fadeWindowSlots) - 50;
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const t = track(e.mint);
      t.tape.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(e.sol_amount) / SOL,
        user: e.user,
        price: priceOf(e.virtual_quote_reserves, e.virtual_token_reserves),
      });
      while (t.tape.length > 0 && t.tape[0].slot < keepFrom) t.tape.shift();
      touched.add(e.mint);
    }

    // 3. Register newly appeared positions with their intended kind.
    for (const mint of state.positions.keys()) {
      if (!open.has(mint)) {
        open.set(mint, {
          kind: intentByMint.get(mint) ?? 'main',
          entrySlot: slot,
          peakValueSol: 0,
          peakReserveSol: 0,
          sellPending: false,
        });
      }
    }
    // Positions that vanished without a tracked sell (completion/write-off) free their record.
    for (const mint of [...open.keys()]) {
      if (!state.positions.has(mint)) {
        open.delete(mint);
        track(mint).lastExitSlot = slot;
        if (boughtMints.has(mint)) roundTripped.add(mint);
      }
    }

    const committed = () => state.committedPositionCount();
    const hasPendingSell = (mint: Pubkey) => {
      for (const pnd of state.pending.values()) {
        if (pnd.order.side === 'sell' && pnd.order.mint === mint) return true;
      }
      return false;
    };

    // 4. Exits first: they free slots and cash for everything else.
    for (const [mint, holding] of state.positions) {
      const pos = open.get(mint);
      if (pos === undefined || pos.sellPending || hasPendingSell(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = sellQuoteSol(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (value > pos.peakValueSol) pos.peakValueSol = value;
      const rqNow = Number(curve.real_quote_reserves) / SOL;
      if (rqNow > pos.peakReserveSol) pos.peakReserveSol = rqNow;
      const cost = Number(holding.cost_lamports) / SOL;
      let exit = false;
      if (pos.kind === 'probe') {
        exit = true; // probes sell as soon as the buy has landed
      } else if (cost > 0 && value <= cost * (1 - p.stopLossFrac)) {
        exit = true;
      } else if (
        cost > 0 &&
        pos.peakValueSol >= cost * (1 + p.trailArmFrac) &&
        value <= pos.peakValueSol * (1 - p.trailDropFrac)
      ) {
        exit = true;
      } else if (slot - pos.entrySlot >= p.maxHoldSlots) {
        exit = true;
      } else if (
        pos.kind === 'main' &&
        pos.peakReserveSol > 0 &&
        rqNow <= pos.peakReserveSol * (1 - p.reserveDropFrac) &&
        slot - pos.entrySlot >= 100
      ) {
        exit = true; // the climb has reversed: reserve is draining away from its peak
      } else {
        const fade = flowStats(track(mint), slot, p.fadeWindowSlots);
        if (fade.net <= -p.fadeNetOutflowSol) exit = true;
      }
      if (exit) {
        pos.sellPending = true;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: 10_000,
        });
      }
    }

    // 5. Main entries on touched curves.
    let mainCount = 0;
    let exposure = 0;
    for (const [mint, holding] of state.positions) {
      const pos = open.get(mint);
      if (pos !== undefined && pos.kind === 'main') {
        mainCount += 1;
        exposure += Number(holding.cost_lamports) / SOL;
      }
    }
    for (const mint of touched) {
      if (orders.length >= 14) break;
      if (mainCount >= p.maxMainPositions) break;
      if (committed() >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || intentByMint.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.created_slot === null || slot - curve.created_slot < p.minAgeSlots) continue;
      const rq = Number(curve.real_quote_reserves) / SOL;
      if (rq < p.bandLoSol || rq > p.bandHiSol) continue;
      const t = track(mint);
      if (t.entries >= p.maxEntriesPerCurve) continue;
      if (slot - t.lastExitSlot < p.reentryCooldownSlots) continue;
      const s = flowStats(t, slot, p.flowWindowSlots);
      if (s.net < p.minNetInflowSol || s.buys < p.minBuyTrades || s.buyers < p.minDistinctBuyers) continue;
      if (s.rise < p.minPriceRise || s.rise > p.maxPriceRise) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / SOL;
      const stake = Math.min(p.stakeSol, capSol);
      if (stake < 0.1) continue;
      if (exposure + stake > p.maxExposureSol) continue;
      if (Number(state.freeCashLamports()) / SOL < stake + 0.01) continue;
      t.entries += 1;
      intentByMint.set(mint, 'main');
      mainCount += 1;
      exposure += stake;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(stake * SOL)),
        max_slippage_bps: p.buySlippageBps,
      });
    }

    // 6. Probe drip for the 20-coin round-trip guardrail.
    const probeDone = roundTripped.size;
    if (
      probeDone < p.probeTargetCoins &&
      slot - lastProbeSlot >= p.probeEverySlots &&
      committed() < state.hello.caps.max_open_positions &&
      orders.length < 15
    ) {
      // Most-traded touched curve inside the probe liquidity band that we have not round-tripped.
      let best: Pubkey | null = null;
      let bestTrades = -1;
      for (const mint of touched) {
        if (roundTripped.has(mint) || state.positions.has(mint) || intentByMint.get(mint) === 'main') continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rq = Number(curve.real_quote_reserves) / SOL;
        if (rq < p.probeBandLoSol || rq > p.probeBandHiSol) continue;
        if (curve.trades > bestTrades) {
          bestTrades = curve.trades;
          best = mint;
        }
      }
      if (best !== null) {
        const capSol = Number(state.maxBuyLamports(best)) / SOL;
        const amount = Math.min(p.probeSol, capSol);
        if (amount >= 0.012 && Number(state.freeCashLamports()) / SOL >= amount + 0.01) {
          intentByMint.set(best, 'probe');
          lastProbeSlot = slot;
          orders.push({
            side: 'buy',
            mint: best,
            quote_lamports: BigInt(Math.floor(amount * SOL)),
            max_slippage_bps: p.buySlippageBps,
          });
        }
      }
    }

    // Forget intents for mints whose buy never produced a position and is no longer pending.
    if (batch.seq % 64 === 0) {
      const pendingMints = new Set<Pubkey>();
      for (const pnd of state.pending.values()) pendingMints.add(pnd.order.mint);
      for (const mint of [...intentByMint.keys()]) {
        if (!state.positions.has(mint) && !pendingMints.has(mint)) intentByMint.delete(mint);
      }
    }

    return orders;
  }

  return { onBatch };
}
