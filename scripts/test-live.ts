import assert from "node:assert/strict";
import { createThruputClient } from "@thruputchain/client";
import { contractAddress } from "@thruputchain/protocol";
import { setTimeout as sleep } from "node:timers/promises";
import { thruputChain } from "../server/chain.js";
import { networkConfig, networkTransport } from "../server/network.js";

const config = networkConfig();
const chain = thruputChain(config);
await chain.setup(2, console.log);
const client = await createThruputClient({
  cluster: config.cluster,
  transport: networkTransport(config.rpcUrl),
});
const addresses = chain.addresses.map((address) =>
  contractAddress(Buffer.from(address.slice(2), "hex")),
);
const balances = () =>
  Promise.all(
    addresses.map(
      async (address) => (await client.getBalance(address)).rawBalance,
    ),
  );
const before = await balances();
// Submit only one side of the ring so the recipient has no replay-cache writes.
// Sender free HOG also funds storage deposits and is not simply before - amount.
const operations = (await chain.prepare(202, 2)).filter(
  (operation) => operation.sender === 0,
);
const start = performance.now();
const admissions = await chain.submit(operations);
assert.ok(admissions.every((outcome) => outcome === "accepted"));
let pending = operations;
let succeeded = 0;
while (pending.length) {
  assert.ok(performance.now() - start < 60_000, "Receipts timed out");
  await sleep(300);
  const outcomes = await chain.poll(pending);
  assert.ok(
    outcomes.every((outcome) => outcome?.state !== "failed"),
    "Transfer execution failed",
  );
  succeeded += outcomes.filter(
    (outcome) => outcome?.state === "succeeded",
  ).length;
  pending = pending.filter(
    (_, i) => !outcomes[i] || outcomes[i]?.state === "unavailable",
  );
}
const after = await balances();
// Sending can also release expired replay-cache deposits, increasing free HOG.
// Only the inactive recipient has an exact transfer-only balance delta.
assert.equal(after[1], before[1]! + 101n);
console.log(
  JSON.stringify(
    {
      network: config.name,
      rpcUrl: config.rpcUrl,
      succeeded,
      elapsedMs: performance.now() - start,
      balanceDelta: after.map((balance, i) => String(balance - before[i]!)),
      firstHash: operations[0]!.hash,
    },
    null,
    2,
  ),
);
