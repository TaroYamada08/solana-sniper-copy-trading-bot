import { config } from '../config.js';
import logger from '../utils/logger.js';
import { getRoundTrip, priceFromParsed, toSol } from './priceOracle.js';

const book = new Map();
const cooldown = new Map();
const stats = {
  scanned: 0,
  opportunities: 0,
  executed: 0,
  skipped: 0,
};

export function updateBook(parsed, extras = {}) {
  const mint = extras.mint || parsed?.mint;
  if (!mint) return;

  const price = priceFromParsed(parsed);
  const liquidity = Number(parsed?.liquidity || price?.liquiditySol || 0);
  const solMoved = extras.solMoved ?? toSol(parsed?.solChanges);

  const prev = book.get(mint) || {};
  book.set(mint, {
    mint,
    venue: parsed?.pool_status || prev.venue || 'unknown',
    pool: parsed?.pool || prev.pool,
    liquidity,
    solMoved,
    flowPrice: price?.solPerToken || prev.flowPrice,
    lastSeen: Date.now(),
    samples: (prev.samples || 0) + 1,
  });

  if (book.size > config.arbitrage.maxWatchlist) {
    const oldest = [...book.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (oldest) book.delete(oldest.mint);
  }
}

export function markCooldown(mint) {
  cooldown.set(mint, Date.now());
}

const isCooling = (mint) => {
  const ts = cooldown.get(mint);
  if (!ts) return false;
  if (Date.now() - ts > config.arbitrage.cooldownMs) {
    cooldown.delete(mint);
    return false;
  }
  return true;
};

export async function scanOpportunities(activeMints = new Set()) {
  if (!config.modes.arbitrage) return [];

  const now = Date.now();
  const candidates = [...book.values()]
    .filter((item) => now - item.lastSeen < 45_000)
    .filter((item) => item.liquidity >= config.arbitrage.minLiquidity)
    .filter((item) => !activeMints.has(item.mint))
    .filter((item) => !isCooling(item.mint))
    .sort((a, b) => b.liquidity - a.liquidity)
    .slice(0, 8);

  const opportunities = [];

  for (const item of candidates) {
    stats.scanned += 1;
    try {
      const roundTrip = await getRoundTrip(item.mint, config.arbitrage.sizeSol);
      if (!roundTrip) {
        stats.skipped += 1;
        continue;
      }

      item.lastSpreadBps = roundTrip.spreadBps;
      item.lastProfitSol = roundTrip.profitSol;

      if (roundTrip.spreadBps >= config.arbitrage.minSpreadBps && roundTrip.profitSol > 0) {
        stats.opportunities += 1;
        opportunities.push({
          ...roundTrip,
          venue: item.venue,
          liquidity: item.liquidity,
        });
      }
    } catch (error) {
      logger.debug('Arb scan error', { mint: item.mint, error: error.message });
    }
  }

  return opportunities;
}

export function recordExecution() {
  stats.executed += 1;
}

export function getArbStats() {
  return {
    ...stats,
    watchlist: book.size,
    lastSpreads: [...book.values()]
      .filter((item) => item.lastSpreadBps !== undefined)
      .sort((a, b) => (b.lastSpreadBps || 0) - (a.lastSpreadBps || 0))
      .slice(0, 8)
      .map((item) => ({
        mint: item.mint,
        venue: item.venue,
        spreadBps: Number((item.lastSpreadBps || 0).toFixed(1)),
        liquidity: item.liquidity,
      })),
  };
}

export function getBook() {
  return book;
}
