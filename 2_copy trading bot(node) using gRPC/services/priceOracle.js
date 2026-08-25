import axios from 'axios';
import { config, PROGRAM_IDS } from '../config.js';
import logger from '../utils/logger.js';

const LAMPORTS = 1e9;
const quoteCache = new Map();
const CACHE_TTL_MS = 1200;

const jupiterHeaders = () => {
  const headers = { Accept: 'application/json' };
  if (config.api.jupiter) {
    headers['x-api-key'] = config.api.jupiter;
  }
  return headers;
};

export const toSol = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1000 ? n / LAMPORTS : n;
};

export const priceFromParsed = (parsed) => {
  if (!parsed) return null;

  const ctx = parsed.context || {};
  const sol = toSol(parsed.solChanges);
  const token = Number(parsed.tokenChanges) || 0;

  if (sol > 0 && token > 0) {
    const tokenUi = token > 1e6 ? token / 1e6 : token;
    return {
      solPerToken: sol / tokenUi,
      solMoved: sol,
      liquiditySol: Number(parsed.liquidity) || 0,
      venue: parsed.pool_status || 'unknown',
      source: 'flow',
    };
  }

  const virtualSol = Number(ctx.virtualSolReserves || ctx.poolQuoteTokenReserves || ctx.realQuoteAfter || 0);
  const virtualToken = Number(ctx.virtualTokenReserves || ctx.poolBaseTokenReserves || ctx.realBaseAfter || 0);
  if (virtualSol > 0 && virtualToken > 0) {
    return {
      solPerToken: (virtualSol / LAMPORTS) / (virtualToken / 1e6),
      solMoved: sol,
      liquiditySol: Number(parsed.liquidity) || virtualSol / LAMPORTS,
      venue: parsed.pool_status || 'unknown',
      source: 'reserves',
    };
  }

  return null;
};

export async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = config.swap.slippageBps) {
  const qty = Math.floor(Number(amount));
  if (!qty || qty <= 0) return null;

  const cacheKey = `${inputMint}:${outputMint}:${qty}:${slippageBps}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const { data } = await axios.get('https://lite-api.jup.ag/swap/v1/quote', {
      params: {
        inputMint,
        outputMint,
        amount: String(qty),
        slippageBps,
        restrictIntermediateTokens: true,
      },
      headers: jupiterHeaders(),
      timeout: 4000,
    });

    if (data) {
      quoteCache.set(cacheKey, { ts: Date.now(), data });
    }
    return data || null;
  } catch (error) {
    logger.debug('Jupiter quote failed', {
      inputMint,
      outputMint,
      error: error.message,
    });
    return null;
  }
}

export async function getSellValueSol(mint, rawTokenAmount) {
  const amount = Math.floor(Number(rawTokenAmount) || 0);
  if (!mint || amount <= 0) return null;

  const quote = await getJupiterQuote(mint, PROGRAM_IDS.WSOL, amount);
  if (!quote?.outAmount) return null;

  return {
    solOut: Number(quote.outAmount) / LAMPORTS,
    inAmount: Number(quote.inAmount),
    priceImpactPct: Number(quote.priceImpactPct || 0),
    routeCount: quote.routePlan?.length || 0,
    source: 'jupiter',
  };
}

export async function getBuyQuote(mint, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS);
  if (!mint || lamports <= 0) return null;

  const quote = await getJupiterQuote(PROGRAM_IDS.WSOL, mint, lamports);
  if (!quote?.outAmount) return null;

  return {
    solIn: Number(quote.inAmount) / LAMPORTS,
    tokensOut: Number(quote.outAmount),
    priceImpactPct: Number(quote.priceImpactPct || 0),
    otherAmountThreshold: Number(quote.otherAmountThreshold || 0),
    source: 'jupiter',
  };
}

export async function getRoundTrip(mint, solAmount) {
  const buy = await getBuyQuote(mint, solAmount);
  if (!buy?.tokensOut) return null;

  const sell = await getSellValueSol(mint, buy.tokensOut);
  if (!sell?.solOut) return null;

  const profitSol = sell.solOut - buy.solIn;
  const spreadBps = (profitSol / buy.solIn) * 10_000;

  return {
    mint,
    solIn: buy.solIn,
    solOut: sell.solOut,
    tokensOut: buy.tokensOut,
    profitSol,
    spreadBps,
    buyImpact: buy.priceImpactPct,
    sellImpact: sell.priceImpactPct,
  };
}

export function pruneQuoteCache() {
  const now = Date.now();
  for (const [key, value] of quoteCache) {
    if (now - value.ts > 15_000) quoteCache.delete(key);
  }
}
