import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const requiredEnvVars = [
  'PRIVATE_KEY',
  'RPC_URL',
  'GRPC_ENDPOINT',
  'GRPCTOKEN',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const parseBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const parseList = (value) =>
  (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const parseScaleOut = (value) => {
  const raw = value || '1.6:0.35,2.5:0.35';
  return raw
    .split(',')
    .map((part) => {
      const [ratio, sellPct] = part.split(':').map(Number);
      return { ratio, sellPct };
    })
    .filter((level) => level.ratio > 1 && level.sellPct > 0 && level.sellPct < 1);
};

export const PROGRAM_IDS = {
  PUMPFUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMPSWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  LAUNCHLAB: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNygT4xC64SbK9z3sJgUsn',
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  WSOL: 'So11111111111111111111111111111111111111112',
};

export const config = {
  wallet: {
    privateKey: process.env.PRIVATE_KEY,
    rpcUrl: process.env.RPC_URL,
    grpcEndpoint: process.env.GRPC_ENDPOINT,
    grpcToken: process.env.GRPCTOKEN,
  },

  modes: {
    sniper: parseBool(process.env.ENABLE_SNIPER, true),
    copy: parseBool(process.env.ENABLE_COPY, false),
    arbitrage: parseBool(process.env.ENABLE_ARBITRAGE, true),
  },

  trading: {
    sniperAmount: parseFloat(process.env.SNIPERAMOUNT || '0.1'),
    profitTarget: parseFloat(process.env.PROFIT_TARGET || '2.0'),
    stopLoss: parseFloat(process.env.STOP_LOSS || '0.55'),
    maxHoldTime: parseInt(process.env.MAX_HOLD_TIME || '180000', 10),
    minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || '3'),
    maxLiquidity: parseFloat(process.env.MAX_LIQUIDITY || '80'),
    maxPositions: parseInt(process.env.MAX_POSITIONS || '5', 10),
    minTxAge: parseInt(process.env.MIN_TX_AGE || '1', 10),
    minWalletSol: parseFloat(process.env.MIN_WALLET_SOL || '0.05'),
    positionPctOfWallet: parseFloat(process.env.POSITION_PCT_OF_WALLET || '0.08'),
    minLaunchBuySol: parseFloat(process.env.MIN_LAUNCH_BUY_SOL || '0.05'),
    maxLaunchBuySol: parseFloat(process.env.MAX_LAUNCH_BUY_SOL || '25'),
  },

  strategy: {
    trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT || '0.18'),
    tightTrailPct: parseFloat(process.env.TIGHT_TRAIL_PCT || '0.10'),
    timeTightenAfterMs: parseInt(process.env.TIME_TIGHTEN_AFTER_MS || '60000', 10),
    dumpDropPct: parseFloat(process.env.DUMP_DROP_PCT || '0.12'),
    dumpWindowMs: parseInt(process.env.DUMP_WINDOW_MS || '8000', 10),
    scaleOut: parseScaleOut(process.env.SCALE_OUT),
    skipLargeDevBuy: parseBool(process.env.SKIP_LARGE_DEV_BUY, true),
  },

  copy: {
    wallets: parseList(process.env.TARGET_WALLETS).map((w) => w),
    copyRatio: parseFloat(process.env.COPY_RATIO || '1.0'),
    minCopySol: parseFloat(process.env.MIN_COPY_SOL || '0.01'),
    maxCopySol: parseFloat(process.env.MAX_COPY_SOL || '0.2'),
    sellMode: (process.env.COPY_SELL_MODE || 'hybrid').toLowerCase(),
  },

  arbitrage: {
    minSpreadBps: parseInt(process.env.ARB_MIN_SPREAD_BPS || '80', 10),
    sizeSol: parseFloat(process.env.ARB_SIZE_SOL || '0.05'),
    maxLegHoldMs: parseInt(process.env.ARB_MAX_LEG_HOLD_MS || '12000', 10),
    scanIntervalMs: parseInt(process.env.ARB_SCAN_INTERVAL_MS || '2500', 10),
    maxWatchlist: parseInt(process.env.ARB_MAX_WATCHLIST || '40', 10),
    cooldownMs: parseInt(process.env.ARB_COOLDOWN_MS || '20000', 10),
    minLiquidity: parseFloat(process.env.ARB_MIN_LIQUIDITY || '8'),
  },

  pools: {
    pumpFun: parseBool(process.env.ENABLE_PUMPFUN, true),
    pumpSwap: parseBool(process.env.ENABLE_PUMPSWAP, true),
    raydiumLaunchLab: parseBool(process.env.ENABLE_RAYDIUM_LAUNCHLAB, true),
    raydiumCpmm: parseBool(process.env.ENABLE_RAYDIUM_CPMM, true),
  },

  swap: {
    method: process.env.SWAP_METHOD || 'solana',
    slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || '1.0'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '5000', 10),
    priorityFee: parseInt(process.env.PRIORITY_FEE || '1000', 10),
  },

  risk: {
    maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '1.0'),
    maxSingleLoss: parseFloat(process.env.MAX_SINGLE_LOSS || '0.5'),
    tradeCooldown: parseInt(process.env.TRADE_COOLDOWN || '3000', 10),
  },

  notifications: {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    },
    email: {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    discord: {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    },
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    debug: parseBool(process.env.DEBUG, false),
    logToFile: parseBool(process.env.LOG_TO_FILE, true),
    logFilePath: process.env.LOG_FILE_PATH || './logs/trading-bot.log',
  },

  api: {
    helius: process.env.HELIUS_API_KEY,
    jupiter: process.env.JUPITER_API_KEY,
  },

  advanced: {
    mevProtection: parseBool(process.env.ENABLE_MEV_PROTECTION, true),
    backtestMode: parseBool(process.env.BACKTEST_MODE, false),
    paperTrading: parseBool(process.env.PAPER_TRADING, false),
    databaseUrl: process.env.DATABASE_URL || 'sqlite://./trades.db',
  },

  performance: {
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    retryDelay: parseInt(process.env.RETRY_DELAY || '1000', 10),
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '30000', 10),
  },

  security: {
    rateLimiting: parseBool(process.env.ENABLE_RATE_LIMITING, true),
    maxRequestsPerMinute: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '100', 10),
    ipWhitelist: parseBool(process.env.ENABLE_IP_WHITELIST, false),
    allowedIps: parseList(process.env.ALLOWED_IPS).length
      ? parseList(process.env.ALLOWED_IPS)
      : ['127.0.0.1', '::1'],
  },
};

const logsDir = dirname(config.logging.logFilePath);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

export const validateConfig = () => {
  const errors = [];

  if (config.trading.sniperAmount <= 0) {
    errors.push('SNIPERAMOUNT must be greater than 0');
  }
  if (config.trading.profitTarget <= 1.0) {
    errors.push('PROFIT_TARGET must be greater than 1.0');
  }
  if (config.trading.stopLoss >= 1.0) {
    errors.push('STOP_LOSS must be less than 1.0');
  }
  if (config.trading.maxHoldTime <= 0) {
    errors.push('MAX_HOLD_TIME must be greater than 0');
  }
  if (config.trading.minLiquidity <= 0) {
    errors.push('MIN_LIQUIDITY must be greater than 0');
  }
  if (config.modes.copy && config.copy.wallets.length === 0) {
    errors.push('ENABLE_COPY is true but TARGET_WALLETS is empty');
  }
  if (!config.modes.sniper && !config.modes.copy && !config.modes.arbitrage) {
    errors.push('Enable at least one mode: ENABLE_SNIPER, ENABLE_COPY, or ENABLE_ARBITRAGE');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return true;
};

export const getEnabledProgramIds = () => {
  const ids = [];
  if (config.pools.pumpFun) ids.push(PROGRAM_IDS.PUMPFUN);
  if (config.pools.pumpSwap) ids.push(PROGRAM_IDS.PUMPSWAP);
  if (config.pools.raydiumLaunchLab) ids.push(PROGRAM_IDS.LAUNCHLAB);
  if (config.pools.raydiumCpmm) ids.push(PROGRAM_IDS.RAYDIUM_CPMM);
  return ids;
};

export const getModuleConfig = (moduleName) => {
  return config[moduleName] || config;
};

export default config;
