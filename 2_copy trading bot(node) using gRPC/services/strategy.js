import { config } from '../config.js';
import { toSol } from './priceOracle.js';

const recentMints = new Map();
const MINT_COOLDOWN_MS = 45_000;

export function markMintSeen(mint) {
  if (mint) recentMints.set(mint, Date.now());
}

export function wasRecentlySeen(mint) {
  const ts = recentMints.get(mint);
  if (!ts) return false;
  if (Date.now() - ts > MINT_COOLDOWN_MS) {
    recentMints.delete(mint);
    return false;
  }
  return true;
}

export function isPoolEnabled(poolStatus) {
  const status = String(poolStatus || '').toLowerCase();
  if (status.includes('pumpfun')) return config.pools.pumpFun;
  if (status.includes('pumpswap')) return config.pools.pumpSwap;
  if (status.includes('launchlab') || status.includes('launchpad')) return config.pools.raydiumLaunchLab;
  if (status.includes('cpmm') || status === 'raydium') return config.pools.raydiumCpmm;
  return true;
}

export function shouldEnterSnipe(parsed, extras = {}) {
  const errors = [];
  const mint = extras.mint || parsed?.mint;
  const solMoved = extras.solMoved ?? toSol(parsed?.solChanges);
  const liquidity = Number(parsed?.liquidity || extras.liquidity || 0);

  if (!mint) errors.push('missing mint');
  if (!isPoolEnabled(parsed?.pool_status)) errors.push(`pool disabled: ${parsed?.pool_status}`);
  if (wasRecentlySeen(mint)) errors.push('mint recently traded');
  if (liquidity > 0 && liquidity < config.trading.minLiquidity) {
    errors.push(`liquidity ${liquidity.toFixed(2)} below min ${config.trading.minLiquidity}`);
  }
  if (liquidity > config.trading.maxLiquidity) {
    errors.push(`liquidity ${liquidity.toFixed(2)} above max ${config.trading.maxLiquidity}`);
  }
  if (solMoved > 0 && solMoved < config.trading.minLaunchBuySol) {
    errors.push(`launch buy ${solMoved.toFixed(3)} SOL too small`);
  }
  if (solMoved > config.trading.maxLaunchBuySol) {
    errors.push(`launch buy ${solMoved.toFixed(3)} SOL too large`);
  }
  if (config.strategy.skipLargeDevBuy && solMoved > 20) {
    errors.push('possible bundled/dev buy');
  }

  return { allowed: errors.length === 0, errors, solMoved, liquidity, mint };
}

export function sizeBuy(solBudget, walletSol) {
  const pctCap = walletSol * config.trading.positionPctOfWallet;
  const hardCap = config.risk.maxSingleLoss;
  const sized = Math.min(solBudget, pctCap || solBudget, hardCap);
  return Math.max(0, Number(sized.toFixed(4)));
}

export function copyBuySize(targetSol, walletSol) {
  const scaled = targetSol * config.copy.copyRatio;
  const clamped = Math.min(Math.max(scaled, config.copy.minCopySol), config.copy.maxCopySol);
  return sizeBuy(clamped, walletSol);
}

export function evaluateExit(position, currentValueSol, now = Date.now()) {
  const entry = Number(position.entryValue) || 0;
  if (entry <= 0) return { action: 'hold', reason: 'no_entry_value' };

  const ratio = currentValueSol / entry;
  const peakRatio = Math.max(Number(position.peakRatio) || ratio, ratio);
  const holdTime = now - (position.entryTime || now);
  const maxHold = position.maxHoldTime || config.trading.maxHoldTime;
  const remaining = position.remainingFraction ?? 1;

  if (ratio <= config.trading.stopLoss) {
    return { action: 'sell_all', reason: 'stop_loss', ratio, peakRatio, sellPct: 1 };
  }

  if (holdTime >= maxHold) {
    return { action: 'sell_all', reason: 'max_hold_time', ratio, peakRatio, sellPct: 1 };
  }

  if (
    position.peakRatio &&
    position.peakTime &&
    peakRatio - ratio >= config.strategy.dumpDropPct &&
    now - position.peakTime <= config.strategy.dumpWindowMs
  ) {
    return { action: 'sell_all', reason: 'dump', ratio, peakRatio, sellPct: 1 };
  }

  const trailPct =
    holdTime >= config.strategy.timeTightenAfterMs
      ? config.strategy.tightTrailPct
      : config.strategy.trailingStopPct;

  if (peakRatio >= 1.12 && ratio <= peakRatio * (1 - trailPct)) {
    return { action: 'sell_all', reason: 'trailing_stop', ratio, peakRatio, sellPct: 1 };
  }

  const hit = position.scaledLevelsHit || [];
  for (const level of config.strategy.scaleOut) {
    const key = String(level.ratio);
    if (ratio >= level.ratio && !hit.includes(key) && remaining > 0.18) {
      return {
        action: 'sell_pct',
        reason: `scale_out_${level.ratio}x`,
        ratio,
        peakRatio,
        sellPct: level.sellPct,
        levelKey: key,
      };
    }
  }

  return { action: 'hold', reason: null, ratio, peakRatio };
}

export function copySellFraction(sellMode = config.copy.sellMode) {
  if (sellMode === 'smart') return 0;
  if (sellMode === 'mirror') return 1;
  return 0.5;
}
