import { config } from '../config.js';
import logger from '../utils/logger.js';
import notificationService from './notifications.js';
import riskManager from './riskManager.js';
import { getBalance } from '../swap.js';
import { token_buy, token_sell, getSplTokenBalance } from '../fuc.js';
import { getSellValueSol, toSol } from './priceOracle.js';
import {
  shouldEnterSnipe,
  sizeBuy,
  copyBuySize,
  evaluateExit,
  copySellFraction,
  markMintSeen,
} from './strategy.js';
import {
  updateBook,
  scanOpportunities,
  markCooldown,
  recordExecution,
  getArbStats,
} from './arbitrage.js';

const inflight = new Set();

const normalizeMint = (parsed, extras = {}) => extras.mint || parsed?.mint || null;

const isOurWallet = (address) => {
  const wallet = String(process.env.WALLET || "").toLowerCase();
  if (!address || !wallet) return false;
  return String(address).toLowerCase() === wallet;
};

const isTargetWallet = (address) => {
  if (!address) return false;
  return config.copy.wallets.some((w) => w.toLowerCase() === String(address).toLowerCase());
};

const matchedFilters = (filters = []) => ({
  launch: filters.includes('launches') || filters.length === 0,
  copy: filters.includes('copy'),
});

async function openPosition({ mint, solAmount, source, poolStatus, context, extra = {} }) {
  if (!mint || solAmount <= 0) return null;
  if (inflight.has(mint)) return null;

  const tradeCheck = riskManager.canExecuteTrade(solAmount, mint);
  if (!tradeCheck.allowed) {
    logger.warn(`Trade blocked for ${mint}`, { reasons: tradeCheck.errors, source });
    return null;
  }

  inflight.add(mint);
  try {
    if (config.advanced.paperTrading) {
      const fakeHash = `paper-${Date.now()}`;
      riskManager.recordTrade('buy', mint, solAmount, 1, fakeHash, {
        source,
        poolStatus,
        context,
        ...extra,
      });
      markMintSeen(mint);
      logger.info(`PAPER BUY ${mint}`, { solAmount, source });
      return { txHash: fakeHash, paper: true };
    }

    const result = await token_buy(mint, solAmount, poolStatus, context);
    const txHash = result?.txHash || result;
    if (!txHash || txHash === 'stop') {
      logger.error(`Buy failed for ${mint}`, { source });
      return null;
    }

    riskManager.recordTrade('buy', mint, solAmount, 1, txHash, {
      source,
      poolStatus,
      context,
      ...extra,
    });
    markMintSeen(mint);
    await notificationService.notifyTradeExecution('buy', mint, solAmount, 0, txHash);
    logger.info(`Bought ${mint}`, { solAmount, source, txHash });
    return { txHash };
  } catch (error) {
    logger.error(`Open position error for ${mint}`, error);
    await notificationService.notifyError(error, `Buy ${source} ${mint}`);
    return null;
  } finally {
    inflight.delete(mint);
  }
}

async function closeMint(mint, reason, sellPct = 1) {
  const position = riskManager.getPosition(mint);
  if (!position) return false;

  try {
    let balance = await getSplTokenBalance(mint);
    if (!balance || balance <= 0) {
      riskManager.activePositions.delete(mint);
      return false;
    }

    const amount = sellPct >= 0.99 ? balance : Math.floor(balance * sellPct);
    if (amount <= 0) return false;

    if (config.advanced.paperTrading) {
      if (sellPct >= 0.99) {
        riskManager.recordTrade('sell', mint, amount, position.currentPrice || 1, `paper-sell-${Date.now()}`);
      } else {
        riskManager.recordPartialSell(mint, sellPct, reason);
      }
      logger.info(`PAPER SELL ${mint}`, { reason, sellPct });
      return true;
    }

    const result = await token_sell(mint, amount, position.poolStatus, sellPct >= 0.99, position.context);
    const txHash = result?.txHash || result;
    if (!txHash || txHash === 'stop') {
      logger.error(`Sell failed for ${mint}`, { reason });
      return false;
    }

    if (sellPct >= 0.99) {
      riskManager.recordTrade('sell', mint, amount, position.currentPrice || 1, txHash);
      await notificationService.notifyPositionUpdate('closed', mint, { reason, txHash, balance: amount });
    } else {
      riskManager.recordPartialSell(mint, sellPct, reason);
      await notificationService.notifyPositionUpdate('scaled', mint, { reason, txHash, sellPct });
    }

    logger.info(`Sold ${mint}`, { reason, sellPct, txHash });
    return true;
  } catch (error) {
    logger.error(`Close error for ${mint}`, error);
    await notificationService.notifyError(error, `Sell ${mint}`);
    return false;
  }
}

async function handleSnipe(parsed, extras) {
  if (!config.modes.sniper) return;
  const decision = shouldEnterSnipe(parsed, extras);
  if (!decision.allowed) {
    logger.debug(`Snipe skipped ${decision.mint || ''}`, { errors: decision.errors });
    return;
  }

  const walletSol = await getBalance();
  const solAmount = sizeBuy(config.trading.sniperAmount, walletSol);
  if (solAmount <= 0) return;

  await openPosition({
    mint: decision.mint,
    solAmount,
    source: 'snipe',
    poolStatus: parsed?.pool_status,
    context: parsed?.context,
    extra: { liquidity: decision.liquidity },
  });
}

async function handleCopy(parsed, extras) {
  if (!config.modes.copy) return;

  const user = extras.user || parsed?.user;
  if (!isTargetWallet(user) || isOurWallet(user)) return;

  const mint = extras.mint || parsed?.mint;
  if (!mint) return;

  const targetSol = extras.solMoved || toSol(parsed?.solChanges);
  const isBuy = parsed?.isBuy === true;
  const isSell = parsed?.isBuy === false;

  if (isBuy) {
    const walletSol = await getBalance();
    const solAmount = copyBuySize(targetSol, walletSol);
    if (solAmount <= 0) return;

    await openPosition({
      mint,
      solAmount,
      source: 'copy',
      poolStatus: parsed?.pool_status,
      context: parsed?.context,
      extra: { targetWallet: user, targetSol },
    });
    return;
  }

  const fraction = copySellFraction();
  if (!isSell || fraction <= 0) return;
  if (!riskManager.getPosition(mint)) return;

  await closeMint(mint, `copy_sell_${config.copy.sellMode}`, fraction);
}

export async function onChainEvent({ parsed, extras = {}, filters = [], isMintTo = false }) {
  try {
    const mint = normalizeMint(parsed, extras);
    const user = extras.user || parsed?.user;
    const solMoved = extras.solMoved ?? toSol(parsed?.solChanges);

    if (parsed) {
      updateBook(parsed, { mint, solMoved });
    }

    if (mint && riskManager.getPosition(mint) && parsed) {
      const mark = extras.markSol || solMoved;
      if (mark > 0) {
        const position = riskManager.getPosition(mint);
        const estimatedValue = Math.max(mark, position.currentValue || 0);
        riskManager.updatePositionMark(mint, estimatedValue);
      }
    }

    const flags = matchedFilters(filters);

    if (config.modes.copy && (flags.copy || isTargetWallet(user))) {
      await handleCopy(parsed, { ...extras, mint, user, solMoved });
    }

    if (config.modes.sniper && flags.launch && isMintTo && mint) {
      await handleSnipe(parsed, { ...extras, mint, solMoved });
    }
  } catch (error) {
    logger.error('onChainEvent error', error);
  }
}

export async function tickPositions() {
  const positions = riskManager.getActivePositions();
  for (const position of positions) {
    try {
      const balance = await getSplTokenBalance(position.mint);
      if (!balance || balance <= 0) {
        riskManager.activePositions.delete(position.mint);
        continue;
      }

      const mark = await getSellValueSol(position.mint, balance);
      const currentValue = mark?.solOut;
      if (!currentValue || currentValue <= 0) continue;

      riskManager.updatePositionMark(position.mint, currentValue);
      const latest = riskManager.getPosition(position.mint);
      const decision = evaluateExit(latest, currentValue);

      if (decision.action === 'sell_all') {
        logger.info(`Exit ${position.mint}: ${decision.reason}`, {
          ratio: decision.ratio?.toFixed(2),
        });
        await closeMint(position.mint, decision.reason, 1);
      } else if (decision.action === 'sell_pct') {
        logger.info(`Scale-out ${position.mint}: ${decision.reason}`);
        await closeMint(position.mint, decision.reason, decision.sellPct);
        riskManager.markScaleLevel(position.mint, decision.levelKey);
      }
    } catch (error) {
      logger.error(`tickPositions ${position.mint}`, error);
    }
  }
}

export async function tickArbitrage() {
  if (!config.modes.arbitrage) return;

  const active = new Set(riskManager.getActivePositions().map((p) => p.mint));
  const opps = await scanOpportunities(active);

  for (const opp of opps) {
    logger.info(
      `Arb opportunity ${opp.mint} spread ${opp.spreadBps.toFixed(1)} bps profit ~${opp.profitSol.toFixed(4)} SOL`
    );

    const opened = await openPosition({
      mint: opp.mint,
      solAmount: config.arbitrage.sizeSol,
      source: 'arb',
      poolStatus: opp.venue,
      extra: { maxHoldTime: config.arbitrage.maxLegHoldMs, spreadBps: opp.spreadBps },
    });

    markCooldown(opp.mint);
    if (!opened) continue;

    recordExecution();
    await closeMint(opp.mint, 'arb_exit', 1);
  }
}

export async function closeAllPositions(reason = 'shutdown') {
  const positions = riskManager.getActivePositions();
  const results = [];
  for (const position of positions) {
    const ok = await closeMint(position.mint, reason, 1);
    results.push({ mint: position.mint, status: ok ? 'closed' : 'error' });
  }
  return results;
}

export function getEngineStats() {
  return {
    inflight: [...inflight],
    arbitrage: getArbStats(),
    positions: riskManager.getPositionSummary(),
    daily: riskManager.getDailyStats(),
  };
}

export { closeMint };
