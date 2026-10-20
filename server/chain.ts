import { randomBytes } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  createThruputClient,
  createPubkeyAccount,
  createWalletClient,
  hashSignedTransaction,
  serializeSignedTransaction,
  toHex0x,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  HOG_ADDRESS,
  blockHeight,
  gasAmount,
  type Invocation,
} from "@thruputchain/protocol";
import { demoSigner } from "./signer.js";
import {
  receiptResults,
  submissionOutcome,
  rpcBatch,
  type ReceiptPollResult,
} from "./rpc.js";
import {
  networkConfig,
  networkTransport,
  type NetworkConfig,
} from "./network.js";

export interface Operation {
  hash: string;
  payload: string;
  sender: number;
  receiver: number;
}
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

export function thruputChain(config: NetworkConfig = networkConfig()): Chain {
  const { rpcUrl, cluster } = config;
  const connect = () =>
    createThruputClient({ cluster, transport: networkTransport(rpcUrl) });
  let clientPromise: ReturnType<typeof connect> | undefined;
  let transfers: Invocation[] = [];
  async function makeWallet(index: number) {
    const client = await (clientPromise ??= connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    }));
    return createWalletClient({
      client,
      account: createPubkeyAccount({ signer: demoSigner(index), nonce: 0n }),
    });
  }
  const wallets: Awaited<ReturnType<typeof makeWallet>>[] = [];
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
      if (transfers.length !== walletCount) {
        transfers = wallets.slice(0, walletCount).map((_, index) =>
          ERC20.v0_1.transfer.invocation(HOG_ADDRESS, gasAmount(100_000n), {
            receiver: wallets[(index + 1) % walletCount]!.account.address,
            amount: 1n,
          }),
        );
      }
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
      const operations: Operation[] = [];
      for (let i = 0; i < count; i++) {
        const current = sequence++;
        const sender = Number(current % BigInt(walletCount));
        const receiver = (sender + 1) % walletCount;
        const wallet = wallets[sender]!;
        const transaction = await wallet.prepareExecution({
          invocation: transfers[sender]!,
          gasLimit: gasAmount(500_000n),
          nonce: (nonceBase + current) & ((1n << 64n) - 1n),
          // Spread replay-cache buckets even when a low-wallet burst shares a tip.
          blockExpiryHeight: blockHeight(
            tip + 200n + ((current / BigInt(walletCount * 4_000)) % 100n),
          ),
        });
        const signed = await wallet.signTransaction(transaction);
        operations.push({
          hash: toHex0x(hashSignedTransaction(signed)),
          payload: toHex0x(serializeSignedTransaction(signed)),
          sender,
          receiver,
        });
      }
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
