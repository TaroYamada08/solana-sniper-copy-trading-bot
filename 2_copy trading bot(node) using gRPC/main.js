import { newlunched_subscribeCommand } from "./grpc.js";
import { getPublicKeyFromPrivateKey } from "./fuc.js";
import { config, validateConfig } from "./config.js";
import logger from "./utils/logger.js";
import notificationService from "./services/notifications.js";
import riskManager from "./services/riskManager.js";
import {
  tickPositions,
  tickArbitrage,
  closeAllPositions,
  getEngineStats,
  onChainEvent,
} from "./services/engine.js";
import { pruneQuoteCache } from "./services/priceOracle.js";
import chalk from "chalk";

const tradingConfig = config.trading;

export const pump_geyser = async () => {
  try {
    validateConfig();

    const walletKey = getPublicKeyFromPrivateKey();
    process.env.WALLET = process.env.WALLET || walletKey;

    console.log(chalk.magentaBright(`
   ██████╗██████╗ ██╗   ██╗██████╗ ████████╗ ██████╗ ██╗  ██╗██╗███╗   ██╗ ██████╗ 
  ██╔════╝██╔══██╗██║   ██║██╔══██╗╚══██╔══╝██╔═══██╗██║ ██╔╝██║████╗  ██║██╔════╝ 
  ██║     ██████╔╝ ██║ ██╔╝██████╔╝   ██║   ██║   ██║█████╔╝ ██║██╔██╗ ██║██║  ██╗ 
  ██║     ██╔══██╗   ██╔═╝ ██╔═══╝    ██║   ██║   ██║██╔═██╗ ██║██║╚██╗██║██║   ██║
  ╚██████╗██║  ██║   ██║   ██║        ██║   ╚██████╔╝██║  ██╗██║██║ ╚████║╚██████╔╝
   ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚═╝        ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝ ╚═════╝ 
    `));

    logger.info("Starting Solana trading engine v3");
    logger.info(`Wallet: ${walletKey}`);
    logger.info(`Modes: sniper=${config.modes.sniper} copy=${config.modes.copy} arb=${config.modes.arbitrage}`);
    logger.info(`Snipe amount: ${tradingConfig.sniperAmount} SOL | stop ${tradingConfig.stopLoss}x | trail ${config.strategy.trailingStopPct * 100}%`);
    logger.info(`Max positions: ${tradingConfig.maxPositions} | max hold ${tradingConfig.maxHoldTime / 1000}s`);
    if (config.modes.copy) {
      logger.info(`Copy wallets: ${config.copy.wallets.join(", ")} | sell mode ${config.copy.sellMode}`);
    }
    if (config.modes.arbitrage) {
      logger.info(`Arb min spread: ${config.arbitrage.minSpreadBps} bps | size ${config.arbitrage.sizeSol} SOL`);
    }
    if (config.advanced.paperTrading) {
      logger.warn("PAPER TRADING is on — no live swaps will be sent");
    }

    await notificationService.notifyBotStatus("Started", {
      wallet: walletKey,
      modes: config.modes,
      config: tradingConfig,
    });

    setInterval(() => {
      tickPositions().catch((error) => logger.error("Position tick failed", error));
    }, 4000);

    if (config.modes.arbitrage) {
      setInterval(() => {
        tickArbitrage().catch((error) => logger.error("Arb tick failed", error));
      }, config.arbitrage.scanIntervalMs);
    }

    setInterval(() => {
      pruneQuoteCache();
      const riskMetrics = riskManager.getRiskMetrics();
      if (riskMetrics.riskLevel === "HIGH") {
        logger.warn("High risk level detected", riskMetrics);
        notificationService.sendNotification(
          "High risk level detected — review positions",
          "warning",
          riskMetrics
        );
      }
    }, 15000);

    await newlunched_subscribeCommand();
  } catch (error) {
    logger.error("Error in pump_geyser", error);
    await notificationService.notifyError(error, "Bot Startup");
    throw error;
  }
};

export {
  closeAllPositions,
  tickPositions,
  onChainEvent as handleNewTokenLaunch,
  getEngineStats,
};
