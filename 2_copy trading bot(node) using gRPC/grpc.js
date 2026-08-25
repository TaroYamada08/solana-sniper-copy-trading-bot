import "dotenv/config";
import Client from "@triton-one/yellowstone-grpc";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import chalk from "chalk";
import bs58 from "bs58";
import { tOutPut } from "./parsingtransaction.js";
import { onChainEvent } from "./services/engine.js";
import { config, getEnabledProgramIds, PROGRAM_IDS } from "./config.js";
import logger from "./utils/logger.js";

const GRPCTOKEN = process.env.GRPCTOKEN;
const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;
const SOLANA_TOKEN = PROGRAM_IDS.WSOL;
const Raydium_launchpad_authority = "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh";

const defaultClient = new Client(GRPC_ENDPOINT, GRPCTOKEN);

export let isNewLaunchRunning = true;
export const stopNewLaunch = () => {
  isNewLaunchRunning = false;
  logger.warn("Stream monitoring stopped");
};

const buildSubscribeArgs = () => {
  const transactions = {};
  const programIds = getEnabledProgramIds();

  if ((config.modes.sniper || config.modes.arbitrage) && programIds.length) {
    transactions.launches = {
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: programIds,
      accountExclude: [],
      accountRequired: [],
    };
  }

  if (config.modes.copy && config.copy.wallets.length) {
    transactions.copy = {
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: config.copy.wallets,
      accountExclude: [],
      accountRequired: [],
    };
  }

  return {
    accounts: {},
    slots: {},
    transactions,
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    ping: undefined,
    commitment: CommitmentLevel.PROCESSED,
  };
};

function encodeSignature(dataTx) {
  try {
    const sig = dataTx?.transaction?.signatures?.[0] || dataTx?.signature;
    if (!sig) return null;
    return typeof sig === "string" ? sig : bs58.encode(Buffer.from(sig));
  } catch {
    return null;
  }
}

function getAccountKeys(dataTx) {
  const keys =
    dataTx?.transaction?.message?.accountKeys ||
    dataTx?.transaction?.message?.staticAccountKeys ||
    [];
  return keys.map((key) => {
    if (typeof key === "string") return key;
    if (key?.pubkey) return String(key.pubkey);
    try {
      return bs58.encode(Buffer.from(key));
    } catch {
      return String(key);
    }
  });
}

function extractBalanceDeltas(meta) {
  const preTokenBalances = meta?.preTokenBalances || [];
  const postTokenBalances = meta?.postTokenBalances || [];
  if (!postTokenBalances.length) return null;

  let pre_sol = 0;
  let post_sol = 0;
  let pre_token = 0;
  let post_token = 0;
  let token_mint = "";
  let token_owner = "";

  for (const balance of postTokenBalances) {
    if (balance.owner !== Raydium_launchpad_authority) {
      if (balance.mint !== SOLANA_TOKEN) {
        post_token = balance.uiTokenAmount?.uiAmount || 0;
        token_mint = balance.mint;
        token_owner = balance.owner;
      }
    } else {
      post_sol = balance.uiTokenAmount?.uiAmount || 0;
    }
  }

  for (const balance of preTokenBalances) {
    if (balance.owner !== Raydium_launchpad_authority) {
      if (balance.mint !== SOLANA_TOKEN) {
        pre_token = balance.uiTokenAmount?.uiAmount || 0;
      }
    } else {
      pre_sol = balance.uiTokenAmount?.uiAmount || 0;
    }
  }

  return {
    tokenMint: token_mint,
    tokenOwner: token_owner,
    solChanges: post_sol - pre_sol,
    tokenChanges: post_token - pre_token,
  };
}

function hasMintTo(meta) {
  const logs = meta?.logMessages;
  if (!Array.isArray(logs)) return false;
  return logs.some((log) => typeof log === "string" && log.toLowerCase().includes("instruction: mintto"));
}

async function handleStream(client = defaultClient, args = buildSubscribeArgs()) {
  const stream = await client.subscribe(args);

  const streamClosed = new Promise((resolve, reject) => {
    stream.on("error", (error) => {
      logger.error("Stream Error", error);
      reject(error);
      stream.end();
    });
    stream.on("end", resolve);
    stream.on("close", resolve);
  });

  stream.on("data", (data) => {
    if (!isNewLaunchRunning) {
      stream.end();
      return;
    }
    processUpdate(data).catch((error) => logger.error("Error processing transaction data", error));
  });

  try {
    await stream.write(args);
  } catch (error) {
    logger.error("Subscription request failed", error);
    throw error;
  }

  await streamClosed;
}

async function processUpdate(data) {
  if (!data?.transaction?.transaction) return;

  const dataTx = data.transaction.transaction;
  const meta = dataTx?.meta || data.transaction?.meta;
  const filters = data.filters || [];
  const isMintTo = hasMintTo(meta);
  const deltas = extractBalanceDeltas(meta);
  const parsed = await tOutPut(data);
  const keys = getAccountKeys(dataTx);
  const user = parsed?.user || deltas?.tokenOwner || keys[0];
  const mint = parsed?.mint || deltas?.tokenMint;
  const solMoved = Math.abs(deltas?.solChanges || 0) || undefined;

  if (isMintTo) {
    logger.info(`[${new Date().toISOString()}] MintTo detected`);
    if (mint) {
      console.log(chalk.bgBlue.bold(`🪙 Token Mint:`), chalk.white(mint));
      console.log(chalk.bgMagenta.bold(`👤 Token Owner:`), chalk.white(user || ""));
      if (deltas) {
        console.log(
          chalk.bgYellow.bold(`💸 SOL Balance Change:`),
          chalk.yellow(`${deltas.solChanges > 0 ? "+" : ""}${deltas.solChanges}`)
        );
      }
    }
  }

  await onChainEvent({
    parsed,
    filters,
    isMintTo,
    extras: {
      mint,
      user,
      solMoved,
      tokenChange: deltas?.tokenChanges,
      signature: encodeSignature(dataTx),
    },
  });
}

export async function newlunched_subscribeCommand(client = defaultClient, args = buildSubscribeArgs()) {
  isNewLaunchRunning = true;
  const names = Object.keys(args.transactions || {});
  logger.info(`gRPC monitoring started (${names.join(", ") || "none"})`);

  if (!names.length) {
    logger.error("No gRPC filters configured. Enable sniper/copy/arbitrage and pool types.");
    return;
  }

  while (isNewLaunchRunning) {
    try {
      await handleStream(client, args);
    } catch (error) {
      logger.error("Stream error, restarting in 1 second...", error);
      if (isNewLaunchRunning) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  logger.info("gRPC monitoring stopped");
}

export { defaultClient, buildSubscribeArgs as defaultArgs };
