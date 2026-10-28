// Records the period of each devnet block, with about two RPC reads per second.
// Run it beside one or more load tests. If the block period grows with load while the
// rate stays flat, the chain is the limit, not the senders.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const rpcUrl = process.env.THRUPUT_RPC_URL ?? "https://rpc.thruput.network";
const seconds = Number(process.env.WATCH_SECONDS ?? 300);
const output = process.env.WATCH_OUTPUT;
assert.ok(seconds >= 1 && seconds <= 7200, "WATCH_SECONDS must be 1-7200");

interface Block {
  blockHeight: string;
  blockTimepoint: string;
  proposer: string;
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return (await response.json()) as T;
}

async function tip(): Promise<number> {
  const body = await post<{ result: { blockHeight: string } }>({
    jsonrpc: "2.0",
    id: 1,
    method: "getChainTip",
    params: {},
  });
  return Number(body.result.blockHeight);
}

const rows: {
  height: number;
  proposer: string;
  periodS?: number;
  seenAt: number;
}[] = [];
const end = Date.now() + seconds * 1000;
let last = await tip();
let previous: bigint | undefined;
console.log("height\tproposer\tperiod_s\tseen_at");
while (Date.now() < end) {
  try {
    const now = await tip();
    if (now > last) {
      const batch = [];
      for (let height = last + 1; height <= now; height++)
        batch.push({
          jsonrpc: "2.0",
          id: height,
          method: "getBlockByHeight",
          params: { blockHeight: String(height) },
        });
      const replies =
        await post<{ id: number; result?: Block | null }[]>(batch);
      replies.sort((a, b) => a.id - b.id);
      for (const reply of replies) {
        // The index can lag the tip; a missing block is read on the next round.
        if (!reply.result) break;
        const at = BigInt(reply.result.blockTimepoint);
        const periodS =
          previous === undefined ? undefined : Number(at - previous) / 1e9;
        const row = {
          height: reply.id,
          proposer: reply.result.proposer.slice(0, 8),
          periodS,
          seenAt: Date.now(),
        };
        rows.push(row);
        console.log(
          `${row.height}\t${row.proposer}\t${periodS?.toFixed(3) ?? ""}\t${row.seenAt}`,
        );
        previous = at;
        last = reply.id;
      }
    }
  } catch (error) {
    console.error(`read failed: ${String(error)}`);
  }
  await sleep(500);
}

if (output) {
  await mkdir("test-results", { recursive: true });
  await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`);
  console.error(`Wrote ${rows.length} blocks to ${output}`);
}
