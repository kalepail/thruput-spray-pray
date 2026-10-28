// Splits receipt delay into its parts: admission, commit, and indexing.
// Run it beside `npm run test:load` to see where the delay goes under load. It sends one
// transfer per interval from its own wallet, so the spray's poll timing does not count.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
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
} from "@thruputchain/protocol";
import { networkConfig } from "../server/network.js";
import { connectClient, demoWallet } from "../server/prepare.js";
import { demoSigner } from "../server/signer.js";

const rpcUrl = process.env.THRUPUT_RPC_URL ?? "https://rpc.thruput.network";
const seconds = Number(process.env.PROBE_SECONDS ?? 60);
const intervalMs = Number(process.env.PROBE_INTERVAL_MS ?? 1000);
const pollMs = Number(process.env.PROBE_POLL_MS ?? 100);
const seed = process.env.PROBE_WALLET_SEED ?? "spray-and-pray/latency-probe/v1";
assert.ok(seconds >= 1 && seconds <= 3600, "PROBE_SECONDS must be 1-3600");

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error)
    throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}

const { networkHash } = await rpc<{ networkHash: string }>(
  "getNetworkInfo",
  {},
);
const config = networkConfig({
  THRUPUT_NETWORK: "futurenet",
  THRUPUT_RPC_URL: rpcUrl,
  THRUPUT_NETWORK_HASH: networkHash,
});
const client = await connectClient(config);
const wallet = demoWallet(client, await demoSigner(0, seed));
const receiver = demoWallet(client, await demoSigner(1, seed));
if ((await wallet.getBalance()).rawBalance < 10_000_000n) {
  await wallet.requestAirdrop().catch(() => {});
  for (let i = 0; (await wallet.getBalance()).rawBalance < 10_000_000n; i++) {
    assert.ok(
      i < 60,
      `Probe wallet ${toBase58(wallet.account.address)} is not funded`,
    );
    await sleep(1000);
  }
}
const transfer = ERC20.v0_1.transfer.invocation(
  NATIVE_TOKEN_ADDRESS,
  gasAmount(100_000n),
  { receiver: receiver.account.address, amount: 1n },
);

interface Sample {
  hash: string;
  height: string;
  /** Milliseconds from the moment the probe sent the transfer. */
  admittedMs: number;
  /** Identical resends after `retry`. */
  resent: number;
  blockMs: number;
  committedMs: number;
  receiptMs: number;
}

/** Polls until `read` returns a value, then returns it with the time it appeared. */
async function until<T>(label: string, read: () => Promise<T | undefined>) {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  for (;;) {
    const value = await read().catch((error: unknown) => {
      last = error;
      return undefined;
    });
    if (value !== undefined) return { value, at: Date.now() };
    if (Date.now() > deadline)
      throw new Error(`${label} timed out; last error: ${String(last)}`);
    await sleep(pollMs);
  }
}

async function probe(): Promise<Sample> {
  const { blockHeight: tip } = await wallet.getChainTip();
  const signed = await wallet.signTransaction(
    await wallet.prepareExecution({
      invocation: transfer,
      gasLimit: gasAmount(500_000n),
      nonce: crypto.getRandomValues(new BigUint64Array(1))[0]!,
      blockExpiryHeight: blockHeight(tip + 30n),
    }),
  );
  const hash = toBase58(hashSignedTransaction(signed));
  const payload = toHex0x(serializeSignedTransaction(signed));
  const sentAt = Date.now();
  await rpc("sendTransaction", { signedTransaction: payload });
  const admittedAt = Date.now();
  let resent = 0;
  const committed = await until("committed status", async () => {
    const row = await rpc<{ status: string; blockHeight?: string }>(
      "getTransactionStatus",
      { transactionHash: hash },
    );
    // Like the engine, resend identical bytes when the scheduler asks for a retry.
    if (row.status === "retry") {
      resent++;
      await rpc("sendTransaction", { signedTransaction: payload });
    }
    if (row.status !== "committed") throw new Error(JSON.stringify(row));
    return row.blockHeight;
  });
  const receipt = await until("receipt", async () =>
    (await rpc("getTransactionReceipt", { transactionHash: hash })) === null
      ? undefined
      : true,
  );
  const block = await rpc<{ blockTimepoint: string }>("getBlockByHeight", {
    blockHeight: committed.value,
  });
  return {
    hash,
    height: committed.value!,
    admittedMs: admittedAt - sentAt,
    resent,
    blockMs: Number(BigInt(block.blockTimepoint) / 1_000_000n) - sentAt,
    committedMs: committed.at - sentAt,
    receiptMs: receipt.at - sentAt,
  };
}

const runs: Promise<Sample | string>[] = [];
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  runs.push(probe().catch((error: unknown) => String(error)));
  await sleep(intervalMs);
}
const results = await Promise.all(runs);
const samples = results.filter((r): r is Sample => typeof r !== "string");
const errors = results.filter((r): r is string => typeof r === "string");
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
};
const p90 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length * 0.9)]! : NaN;
};
// `blockTimepoint` marks when a block starts, so it can precede the submit; it is a
// diagnostic, not the moment of inclusion. Times use this machine's clock.
const parts = {
  admit: samples.map((s) => s.admittedMs),
  untilCommitted: samples.map((s) => s.committedMs),
  committedToReceipt: samples.map((s) => s.receiptMs - s.committedMs),
  total: samples.map((s) => s.receiptMs),
  blockStartOffset: samples.map((s) => s.blockMs),
  resent: samples.map((s) => s.resent),
};
const summary = Object.fromEntries(
  Object.entries(parts).map(([name, values]) => [
    name,
    { p50: median(values), p90: p90(values) },
  ]),
);
console.log(
  JSON.stringify({ samples: samples.length, errors: errors.length, summary }),
);
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/receipt-latency.json",
  JSON.stringify(
    { date: new Date().toISOString(), pollMs, summary, samples, errors },
    null,
    2,
  ) + "\n",
);
