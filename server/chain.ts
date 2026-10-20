import { randomBytes } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { toHex0x } from "@thruputchain/client";
import {
  connectClient,
  createPreparer,
  demoWallet,
  type Operation,
  type Wallet,
} from "./prepare.js";
import { createPreparePool } from "./prepare-pool.js";
import {
  receiptResults,
  submissionOutcome,
  rpcBatch,
  type ReceiptPollResult,
} from "./rpc.js";
import { networkConfig, type NetworkConfig } from "./network.js";

export type { Operation } from "./prepare.js";
export interface Chain {
  network: string;
  addresses: string[];
  setup(count: number, progress: (message: string) => void): Promise<void>;
  prepare(count: number, wallets: number): Promise<Operation[]>;
  submit(
    operations: Operation[],
  ): Promise<("accepted" | "rejected" | "unknown")[]>;
  poll(operations: Operation[]): Promise<ReceiptPollResult[]>;
}

export function thruputChain(
  config: NetworkConfig = networkConfig(),
  options: { prepareWorkers?: number; env?: NodeJS.ProcessEnv } = {},
): Chain {
  const { rpcUrl, cluster } = config;
  const connect = () => connectClient(config);
  let clientPromise: ReturnType<typeof connect> | undefined;
  async function makeWallet(index: number) {
    const client = await (clientPromise ??= connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    }));
    return demoWallet(client, index);
  }
  const wallets: Wallet[] = [];
  const prepareInline = createPreparer(wallets);
  const pool = options.prepareWorkers
    ? createPreparePool(options.prepareWorkers, options.env ?? process.env)
    : undefined;
  let tip = 0n;
  let tipAt = 0;
  let tipRequest: Promise<void> | undefined;
  let sequence = 0n;
  const nonceBase = BigInt(`0x${randomBytes(8).toString("hex")}`);
  const chain: Chain = {
    network: config.name,
    addresses: [],
    async setup(count, progress) {
      for (let i = 0; i < count; i++) {
        progress(`Preparing wallet ${i + 1} of ${count}`);
        let wallet = wallets[i];
        if (!wallet) {
          wallet = await makeWallet(i);
          wallets.push(wallet);
          chain.addresses.push(toHex0x(wallet.account.address));
        }
        const balance = await wallet.getBalance();
        if (balance.rawBalance < 10_000_000n) {
          progress(`Funding wallet ${i + 1} of ${count}`);
          const airdrop = await wallet
            .requestAirdrop()
            .catch((error: unknown) => {
              const reason =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `${config.name} funding for wallet ${i + 1} (${toHex0x(wallet.account.address)}) could not finish: ${reason}. Check the faucet cooldown, then retry Apply configuration.`,
                { cause: error },
              );
            });
          if (airdrop.status.result !== "ok")
            throw new Error(
              `Wallet ${i + 1} funding failed: ${airdrop.status.result}`,
            );
          if ((await wallet.getBalance()).rawBalance < 10_000_000n)
            throw new Error(`Wallet ${i + 1} needs at least 1 test HOG`);
        }
      }
    },
    async prepare(count, walletCount) {
      const first = wallets[0];
      if (!first) throw new Error("Wallet pool is not ready");
      if (Date.now() - tipAt > 2_000) {
        tipRequest ??= first
          .getChainTip()
          .then((value) => {
            tip = value.height;
            tipAt = Date.now();
          })
          .finally(() => {
            tipRequest = undefined;
          });
        await tipRequest;
      }
      const start = sequence;
      sequence += BigInt(count);
      const request = { start, count, walletCount, tip, nonceBase };
      const operations = await (pool?.prepare(request) ??
        prepareInline(request));
      await setImmediate();
      return operations;
    },
    async submit(operations) {
      const rows = await rpcBatch(
        rpcUrl,
        "groundhog_sendRawTransaction",
        operations.map((op) => [op.payload]),
      );
      return rows.map((row, i) => submissionOutcome(operations[i]!.hash, row));
    },
    async poll(operations) {
      const rows = await rpcBatch(
        rpcUrl,
        "groundhog_getTransactionReceipt",
        operations.map((op) => [op.hash]),
      );
      return receiptResults(
        operations.map((op) => op.hash),
        rows,
      );
    },
  };
  return chain;
}
