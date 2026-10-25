import {
  createThruputClient,
  createPubkeyAccount,
  createWalletClient,
  hashSignedTransaction,
  serializeSignedTransaction,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import { ERC20 } from "@thruputchain/client/contracts";
import {
  NATIVE_TOKEN_ADDRESS,
  blockHeight,
  gasAmount,
  type Invocation,
} from "@thruputchain/protocol";
import type { Signer } from "@thruputchain/client";
import { networkTransport, type NetworkConfig } from "./network.js";

export interface Operation {
  hash: string;
  payload: string;
  sender: number;
  receiver: number;
}

/** A contiguous range of the transfer sequence, signed against one chain tip. */
export interface PrepareRequest {
  start: bigint;
  count: number;
  walletCount: number;
  tip: bigint;
  nonceBase: bigint;
  /** Wallet indexes that sign, in rotation; all wallets when omitted. */
  senders?: number[];
  /**
   * When several shards sign for the same wallet, each takes every `slots`-th expiry
   * height starting at `slot`, so their replay-cache entries never share a bucket.
   */
  slot?: number;
  slots?: number;
  /** Expiry height for each transfer; the counter-based buckets when omitted. */
  expiryHeights?: bigint[];
}

export function connectClient(config: NetworkConfig) {
  return createThruputClient({
    cluster: config.cluster,
    transport: networkTransport(config.rpcUrl),
  });
}
type Client = Awaited<ReturnType<typeof connectClient>>;
export type Wallet = ReturnType<typeof demoWallet>;

export function demoWallet(client: Client, signer: Signer) {
  return createWalletClient({
    client,
    account: createPubkeyAccount({ signer, nonce: 0n }),
  });
}

/** Signs one range; inline callers and worker threads share this exact path. */
export function createPreparer(wallets: Wallet[]) {
  let transfers: Invocation[] = [];
  return async function prepare(request: PrepareRequest): Promise<Operation[]> {
    const { walletCount } = request;
    if (wallets.length < walletCount)
      throw new Error("Wallet pool is not ready");
    if (transfers.length !== walletCount) {
      transfers = wallets.slice(0, walletCount).map((_, index) =>
        ERC20.v0_1.transfer.invocation(
          NATIVE_TOKEN_ADDRESS,
          gasAmount(100_000n),
          {
            receiver: wallets[(index + 1) % walletCount]!.account.address,
            amount: 1n,
          },
        ),
      );
    }
    const operations: Operation[] = [];
    for (let i = 0; i < request.count; i++) {
      const current = request.start + BigInt(i);
      const senders = request.senders;
      const sender = senders
        ? senders[Number(current % BigInt(senders.length))]!
        : Number(current % BigInt(walletCount));
      const receiver = (sender + 1) % walletCount;
      const wallet = wallets[sender]!;
      const transaction = await wallet.prepareExecution({
        invocation: transfers[sender]!,
        gasLimit: gasAmount(500_000n),
        nonce: (request.nonceBase + current) & ((1n << 64n) - 1n),
        // Spread replay-cache buckets even when a low-wallet burst shares a tip:
        // about 4,000 transfers per sender share an expiry height.
        blockExpiryHeight: blockHeight(
          request.expiryHeights?.[i] ??
            request.tip +
              200n +
              (((current / BigInt((senders?.length ?? walletCount) * 4_000)) *
                BigInt(request.slots ?? 1) +
                BigInt(request.slot ?? 0)) %
                100n),
        ),
      });
      const signed = await wallet.signTransaction(transaction);
      operations.push({
        hash: toBase58(hashSignedTransaction(signed)),
        payload: toHex0x(serializeSignedTransaction(signed)),
        sender,
        receiver,
      });
    }
    return operations;
  };
}
