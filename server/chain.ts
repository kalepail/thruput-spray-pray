import { toHex0x } from "@thruputchain/client";
import {
  connectClient,
  createPreparer,
  demoWallet,
  type Operation,
  type Wallet,
} from "./prepare.js";
import { demoSigner } from "./signer.js";
import {
  receiptResults,
  submissionOutcome,
  rpcBatch,
  fetchPost,
  statusResults,
  type TxStatus,
  type ReceiptPollResult,
  type RpcPost,
} from "./rpc.js";
import type { NetworkConfig } from "./network.js";

export type { Operation } from "./prepare.js";

const TIP_MAX_AGE_MS = 30_000;
export interface Chain {
  network: string;
  addresses: string[];
  setup(count: number, progress: (message: string) => void): Promise<void>;
  prepare(count: number, wallets: number): Promise<Operation[]>;
  submit(
    operations: Operation[],
  ): Promise<("accepted" | "rejected" | "unknown")[]>;
  poll(operations: Operation[]): Promise<ReceiptPollResult[]>;
  /** Scheduler status for transfers whose receipts are overdue. */
  status?(operations: Operation[]): Promise<TxStatus[]>;
}

export function thruputChain(
  config: NetworkConfig,
  /** `senders` limits signing and funding to some wallets, for one shard of the ring. */
  options: {
    post?: RpcPost;
    senders?: number[];
    /** This shard's expiry-height slot when `slots` shards share its senders. */
    slot?: number;
    slots?: number;
    /** Wallet key seed; see demoSigner. */
    walletSeed?: string;
  } = {},
): Chain {
  const { senders, slot, slots, walletSeed } = options;
  const { rpcUrl } = config;
  const post = options.post ?? fetchPost(rpcUrl);
  const connect = () => connectClient(config);
  let clientPromise: ReturnType<typeof connect> | undefined;
  async function makeWallet(index: number) {
    const client = await (clientPromise ??= connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    }));
    return demoWallet(client, await demoSigner(index, walletSeed));
  }
  const wallets: Wallet[] = [];
  const prepare = createPreparer(wallets);
  let tip = 0n;
  let tipAt = 0;
  let tipRequest: Promise<void> | undefined;
  let sequence = 0n;
  const [nonceBase] = crypto.getRandomValues(new BigUint64Array(1));
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
        // Receivers only need an address; only signing wallets spend storage deposits.
        if (senders && !senders.includes(i)) continue;
        const balance = await wallet.getBalance();
        if (balance.rawBalance < 10_000_000n) {
          progress(`Funding wallet ${i + 1} of ${count}`);
          const airdrop = await wallet
            .requestAirdrop()
            .catch(async (error: unknown) => {
              // Shards that share a sender fund it at the same time; the faucet then
              // refuses all but one request. Accept the wallet if another one landed.
              if ((await wallet.getBalance()).rawBalance >= 10_000_000n)
                return { status: { result: "ok" as const } };
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
        // Expiry keeps 200+ blocks of slack, so a tip a few seconds old is safe. Waiting
        // here would stall every batch behind the submits and polls queued for a
        // connection.
        if (Date.now() - tipAt > TIP_MAX_AGE_MS) await tipRequest;
        else tipRequest.catch(() => {});
      }
      const start = sequence;
      sequence += BigInt(count);
      const request = {
        start,
        count,
        walletCount,
        tip,
        nonceBase: nonceBase!,
        senders,
        slot,
        slots,
      };
      const operations = await prepare(request);
      // Yield so WebSocket input and receipt polling run between batches.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return operations;
    },
    async submit(operations) {
      const rows = await rpcBatch(
        post,
        "groundhog_sendRawTransaction",
        operations.map((op) => [op.payload]),
      );
      return rows.map((row, i) => submissionOutcome(operations[i]!.hash, row));
    },
    async status(operations) {
      return statusResults(
        await rpcBatch(
          post,
          "groundhog_getTransactionStatus",
          operations.map((op) => [op.hash]),
        ),
      );
    },
    async poll(operations) {
      const rows = await rpcBatch(
        post,
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
