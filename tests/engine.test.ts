import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Engine } from "../server/engine.js";
import type { Chain, Operation } from "../server/chain.js";

function fixture(overrides: Partial<Chain> = {}) {
  let sequence = 0;
  const chain: Chain = {
    network: "test",
    addresses: ["a", "b"],
    async setup() {},
    async prepare(count) {
      return Array.from({ length: count }, (): Operation => ({
        hash: String(sequence++),
        payload: "x",
        sender: 0,
        receiver: 1,
      }));
    },
    async submit(ops) {
      return ops.map(() => "accepted");
    },
    async poll(ops) {
      return ops.map(() => ({ state: "succeeded" as const, height: "10" }));
    },
    ...overrides,
  };
  const engine = new Engine(chain, {
    outstanding: 8,
    receiptTimeoutMs: 700,
    leaseMs: 250,
  });
  return engine;
}
async function ready(engine: Engine) {
  await engine.configure({ batchSize: 4, concurrency: 2 });
}
async function waitFor(predicate: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await sleep(20);
  }
}

test("bounds pending work and drains successful receipts after release", async (t) => {
  const engine = fixture();
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0.5, y: 0.5 });
  await waitFor(() => engine.snapshot().attempted === 8);
  assert.equal(engine.snapshot().pending, 8);
  assert.equal(engine.snapshot().succeeded, 0);
  assert.equal(engine.snapshot().backpressure, true);
  assert.throws(() => engine.spray("b", { x: 0, y: 0 }), /Another browser/);
  await assert.rejects(
    engine.configure({ batchSize: 4, concurrency: 2 }),
    /drain/,
  );
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().succeeded, 8);
  assert.equal(engine.snapshot().pending, 0);
  assert.equal(engine.snapshot().failed, 0);
  assert.equal(engine.snapshot().observedBlocks, 1);
  assert.equal(engine.snapshot().averageTxPerBlock, 8);
  assert.ok(engine.snapshot().averageReceiptMs > 0);
  assert.equal(engine.snapshot().backpressure, false);
  const elapsed = engine.snapshot().elapsedMs;
  await sleep(100);
  assert.equal(engine.snapshot().elapsedMs, elapsed);
  engine.reset();
  assert.equal(engine.snapshot().attempted, 0);
  assert.equal(engine.snapshot().observedBlocks, 0);
  assert.equal(engine.snapshot().averageTxPerBlock, 0);
  assert.equal(engine.snapshot().averageReceiptMs, 0);
});

test("configuration and transaction preparation always use four wallets", async (t) => {
  const funded: number[] = [];
  const prepared: number[] = [];
  let sequence = 0;
  const engine = fixture({
    async setup(count) {
      funded.push(count);
    },
    async prepare(count, wallets) {
      prepared.push(wallets);
      return Array.from({ length: count }, () => ({
        hash: String(sequence++),
        payload: "x",
        sender: 0,
        receiver: 1,
      }));
    },
  });
  t.after(() => engine.close());
  await ready(engine);
  await engine.configure({ batchSize: 2, concurrency: 1 });
  assert.deepEqual(funded, [4, 4]);
  assert.equal(engine.snapshot().walletCount, 4);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted > 0);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.ok(prepared.length > 0 && prepared.every((count) => count === 4));
});

test("lost submit response is polled by original hash, never resubmitted", async (t) => {
  const sent: string[] = [];
  const engine = fixture({
    async submit(ops) {
      sent.push(...ops.map((o) => o.hash));
      throw new Error("lost response");
    },
  });
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted === 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().succeeded, 8);
  assert.equal(engine.snapshot().accepted, 0);
  assert.equal(new Set(sent).size, sent.length);
});

test("receipt deadline is unresolved, lease expiration stops generation", async (t) => {
  const engine = fixture({
    async poll(ops) {
      return ops.map(() => undefined);
    },
  });
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().unresolved, 8);
  assert.equal(engine.snapshot().failed, 0);
  assert.equal(engine.snapshot().owner, null);
});

test("release during signing discards prepared work", async (t) => {
  let release!: (ops: Operation[]) => void;
  const engine = fixture({
    prepare: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  t.after(() => engine.close());
  await engine.configure({ batchSize: 4, concurrency: 1 });
  engine.spray("a", { x: 0, y: 0 });
  engine.stop("a");
  release([{ hash: "discard", payload: "x", sender: 0, receiver: 1 }]);
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().attempted, 0);
});

test("admission and execution failures settle exactly once", async (t) => {
  const engine = fixture({
    async submit(ops) {
      return ops.map((_, i) => (i % 2 ? "accepted" : "rejected"));
    },
    async poll(ops) {
      return ops.map(() => ({ state: "failed" as const, height: "10" }));
    },
  });
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  engine.stop("not-owner");
  await waitFor(() => engine.snapshot().attempted >= 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  const s = engine.snapshot();
  assert.equal(s.failed, s.attempted);
  assert.equal(s.succeeded + s.failed + s.unresolved + s.pending, s.attempted);
});

test("duplicate prepared identities are rejected before mutating accounting", async (t) => {
  const operation = { hash: "duplicate", payload: "x", sender: 0, receiver: 1 };
  const engine = fixture({
    async prepare() {
      return [operation, operation];
    },
  });
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().attempted, 0);
  assert.equal(engine.snapshot().pending, 0);
  assert.match(engine.snapshot().errors.join(), /Duplicate/);
});

test("failed setup can be retried after the node recovers", async (t) => {
  let offline = true;
  const engine = fixture({
    async setup() {
      if (offline) throw new Error("Node unavailable");
    },
  });
  t.after(() => engine.close());
  await assert.rejects(ready(engine), /Node unavailable/);
  assert.equal(engine.snapshot().phase, "error");
  assert.throws(() => engine.spray("a", { x: 0, y: 0 }), /Node unavailable/);
  offline = false;
  await ready(engine);
  assert.equal(engine.snapshot().phase, "ready");
});

test("block average deduplicates out-of-order heights and excludes failed-only blocks", async (t) => {
  const engine = fixture({
    async poll(ops) {
      return ops.map((op) =>
        Number(op.hash) % 3 === 0
          ? { state: "failed" as const, height: "99" }
          : {
              state: "succeeded" as const,
              height: Number(op.hash) % 2 ? "11" : "10",
            },
      );
    },
  });
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted === 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().succeeded, 5);
  assert.equal(engine.snapshot().failed, 3);
  assert.equal(engine.snapshot().observedBlocks, 2);
  assert.equal(engine.snapshot().averageTxPerBlock, 2.5);
});

test("slow receipt batch does not block the other polling slots", async (t) => {
  let sequence = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const engine = new Engine(
    {
      network: "test",
      addresses: [],
      async setup() {},
      async prepare(count) {
        return Array.from({ length: count }, () => ({
          hash: String(sequence++),
          payload: "x",
          sender: 0,
          receiver: 1,
        }));
      },
      async submit(ops) {
        return ops.map(() => "accepted");
      },
      async poll(ops) {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        if (calls === 1) await gate;
        active--;
        return ops.map(() => ({ state: "succeeded" as const, height: "1" }));
      },
    },
    { outstanding: 2048, receiptTimeoutMs: 3000, leaseMs: 2000 },
  );
  t.after(() => {
    release();
    engine.close();
  });
  await engine.configure({ batchSize: 256, concurrency: 4 });
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted === 2048);
  engine.stop("a");
  await waitFor(() => calls >= 8);
  assert.equal(engine.snapshot().pending, 256);
  assert.ok(maximum <= 4);
  release();
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().succeeded, 2048);
});

test("pending submissions are not reserved twice after another batch settles", async (t) => {
  let sequence = 0;
  let submissions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = new Engine(
    {
      network: "test",
      addresses: [],
      async setup() {},
      async prepare(count) {
        return Array.from({ length: count }, () => ({
          hash: String(sequence++),
          payload: "x",
          sender: 0,
          receiver: 1,
        }));
      },
      async submit(ops) {
        if (++submissions === 2) await gate;
        return ops.map(() => "accepted");
      },
      async poll(ops) {
        return ops.map(() => ({ state: "succeeded" as const, height: "1" }));
      },
    },
    { outstanding: 8, receiptTimeoutMs: 3000, leaseMs: 2000 },
  );
  t.after(() => {
    release();
    engine.close();
  });
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted >= 12);
  assert.ok(engine.snapshot().pending <= 8);
  engine.stop("a");
  release();
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().succeeded, engine.snapshot().attempted);
});
