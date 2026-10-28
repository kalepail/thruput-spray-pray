import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Engine,
  engineLimits,
  isNetworkFailure,
  type EngineLimits,
} from "../server/engine.js";
import type { Chain, Operation } from "../server/chain.js";
import { RpcConnectionError } from "../server/errors.js";

function fixture(
  overrides: Partial<Chain> = {},
  limits: Partial<EngineLimits> = {},
) {
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
    ...limits,
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
  assert.ok(engine.snapshot().recentReceiptMs > 0);
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

test("configuration and transaction preparation always use the configured wallet count", async (t) => {
  const funded: number[] = [];
  const prepared: number[] = [];
  let sequence = 0;
  const engine = fixture(
    {
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
    },
    { wallets: 6 },
  );
  t.after(() => engine.close());
  await ready(engine);
  await engine.configure({ batchSize: 2, concurrency: 1 });
  assert.deepEqual(funded, [6, 6]);
  assert.equal(engine.snapshot().walletCount, 6);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted > 0);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.ok(prepared.length > 0 && prepared.every((count) => count === 6));
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

test("opt-in resend repeats identical bytes after a lost connection", async (t) => {
  const sent: string[] = [];
  const failedOnce = new Set<string>();
  const engine = fixture(
    {
      async submit(ops) {
        sent.push(...ops.map((o) => o.payload + o.hash));
        const key = ops[0]!.hash;
        if (!failedOnce.has(key)) {
          failedOnce.add(key);
          throw new TypeError("fetch failed");
        }
        // Devnet answers a duplicate of an admitted transfer with the same hash.
        return ops.map(() => "accepted");
      },
    },
    { submitRetries: 1 },
  );
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted === 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().succeeded, 8);
  assert.equal(engine.snapshot().accepted, 8);
  assert.equal(engine.snapshot().failed, 0);
  assert.equal(sent.length, 16);
  assert.equal(new Set(sent).size, 8);
});

test("probe polling checks one transfer per batch, then the rest of its batch", async (t) => {
  const polls: string[][] = [];
  const engine = fixture(
    {
      async poll(ops) {
        polls.push(ops.map((o) => o.hash));
        return ops.map(() => ({ state: "succeeded" as const, height: "10" }));
      },
    },
    { probeIntervalMs: 20, firstPollMs: 10, pollIntervalMs: 5000 },
  );
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted === 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(engine.snapshot().succeeded, 8);
  // Batches of four: hashes 0 and 4 are probes. Each transfer is looked up once,
  // and never before the probe of its own batch.
  const order = polls.flat();
  assert.equal(order.length, 8);
  for (const hash of order) {
    const probe = String(Math.floor(Number(hash) / 4) * 4);
    assert.ok(order.indexOf(probe) <= order.indexOf(hash));
  }
  assert.deepEqual(engine.snapshot().recentBlocks, [
    { height: "10", succeeded: 8 },
  ]);
});

test("a send rate paces batches instead of filling the in-flight cap at once", async (t) => {
  // 40 transfers/s in batches of 4: after the saved-up first second, 10 batches a second.
  const engine = fixture({}, { outstanding: 1000, rate: 40, leaseMs: 5000 });
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0.5, y: 0.5 });
  await sleep(300);
  const start = engine.snapshot().attempted;
  await sleep(500);
  const sent = engine.snapshot().attempted - start;
  engine.stop("a");
  assert.ok(start <= 56, `first ${start}`);
  assert.ok(sent >= 12 && sent <= 32, `sent ${sent} in 0.5 s`);
  assert.equal(engineLimits({}).rate, 0);
  assert.throws(() => engineLimits({ SPRAY_RATE: "-1" }), /SPRAY_RATE/);
});

test("sampled receipts settle unsampled members from their probe", async (t) => {
  const polls: string[] = [];
  const engine = fixture(
    {
      async poll(ops) {
        polls.push(...ops.map((o) => o.hash));
        // The second batch's probe fails, so its members must be looked up.
        return ops.map((o) =>
          o.hash === "4"
            ? { state: "failed" as const, height: "10" }
            : { state: "succeeded" as const, height: "10" },
        );
      },
    },
    {
      probeIntervalMs: 20,
      firstPollMs: 10,
      pollIntervalMs: 5000,
      receiptSample: 1_000_000,
    },
  );
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted === 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  const snapshot = engine.snapshot();
  assert.deepEqual(polls.sort(), ["0", "4", "5", "6", "7"]);
  assert.equal(snapshot.assumed, 3);
  assert.equal(snapshot.succeeded, 7);
  assert.equal(snapshot.failed, 1);
});

test("engine limits reject values that would stall or unbound the engine", () => {
  assert.equal(engineLimits({}).outstanding, 8192);
  assert.equal(engineLimits({ SPRAY_OUTSTANDING: " " }).outstanding, 8192);
  for (const [name, value] of [
    ["SPRAY_POLL_CONCURRENCY", "0"],
    ["SPRAY_POLL_BATCH", "0"],
    ["SPRAY_OUTSTANDING", "1.5"],
    ["SPRAY_SUBMIT_RETRIES", "-1"],
    ["SPRAY_FIRST_POLL_RATIO", "9"],
  ] as const)
    assert.throws(() => engineLimits({ [name]: value }), new RegExp(name));
});

test("only network failures are resent; a rejection after a resend fails", async (t) => {
  assert.equal(isNetworkFailure(new TypeError("fetch failed")), true);
  assert.equal(
    isNetworkFailure(new DOMException("slow", "TimeoutError")),
    true,
  );
  assert.equal(isNetworkFailure(new Error("RPC HTTP 503")), false);
  // The Workers runtime: socket-pool connection loss and workerd fetch() loss.
  assert.equal(isNetworkFailure(new RpcConnectionError("closed")), true);
  assert.equal(isNetworkFailure(new Error("Network connection lost.")), true);
  const failedOnce = new Set<string>();
  const engine = fixture(
    {
      async submit(ops) {
        const key = ops[0]!.hash;
        if (!failedOnce.has(key)) {
          failedOnce.add(key);
          throw new TypeError("fetch failed");
        }
        return ops.map(() => "rejected");
      },
    },
    { submitRetries: 1 },
  );
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted >= 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  const { attempted, failed, unresolved } = engine.snapshot();
  assert.equal(failed, attempted);
  assert.equal(unresolved, 0);
});

test("HTTP errors are not resent", async (t) => {
  let calls = 0;
  const engine = fixture(
    {
      async submit() {
        calls++;
        throw new Error("RPC HTTP 503");
      },
    },
    { submitRetries: 2 },
  );
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted === 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  assert.equal(calls, 2);
});

test("recent blocks keep the latest 16 heights in numeric order", async (t) => {
  let height = 0;
  const engine = fixture({
    async poll(ops) {
      return ops.map(() => ({
        state: "succeeded" as const,
        height: String(98 + (height++ % 20)),
      }));
    },
  });
  t.after(() => engine.close());
  await ready(engine);
  const spray = () => engine.spray("a", { x: 0, y: 0 });
  spray();
  const heartbeat = setInterval(spray, 50);
  try {
    await waitFor(() => engine.snapshot().succeeded >= 40, 5000);
  } finally {
    clearInterval(heartbeat);
  }
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  const heights = engine.snapshot().recentBlocks.map((block) => block.height);
  assert.equal(heights.length, 16);
  assert.deepEqual(
    heights,
    Array.from({ length: 16 }, (_, i) => String(102 + i)),
  );
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

test("scheduler retry resends identical bytes; dropped transfers fail", async (t) => {
  const sent: string[] = [];
  const resent = new Set<string>();
  const engine = fixture(
    {
      async submit(ops) {
        sent.push(...ops.map((o) => o.payload + o.hash));
        return ops.map(() => "accepted");
      },
      // Even hashes lose a storage conflict until resent; hash "1" is dropped.
      async poll(ops) {
        return ops.map((op) =>
          Number(op.hash) % 2 === 1 || resent.has(op.hash)
            ? op.hash === "1"
              ? undefined
              : { state: "succeeded" as const, height: "10" }
            : undefined,
        );
      },
      async status(ops) {
        return ops.map((op) => {
          if (op.hash === "1") return "dropped";
          resent.add(op.hash);
          return "retry";
        });
      },
    },
    { statusAfterMs: 100, pollIntervalMs: 20, firstPollMs: 20 },
  );
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().attempted >= 8);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready");
  const state = engine.snapshot();
  assert.equal(state.failed, 1);
  assert.equal(state.unresolved, 0);
  assert.equal(state.succeeded, state.attempted - 1);
  assert.equal(state.resubmitted, Math.ceil(state.attempted / 2));
  // Every resend repeats the exact signed bytes of an earlier submission.
  const first = new Set(sent.slice(0, state.attempted));
  for (const copy of sent.slice(state.attempted)) assert.ok(first.has(copy));
});

test("live rates use the covered window, not a fixed 5 s, after activity starts", async (t) => {
  const engine = fixture({}, { outstanding: 4 });
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0, y: 0 });
  await waitFor(() => engine.snapshot().succeeded >= 4);
  engine.stop("a");
  const { liveTps, succeeded } = engine.snapshot();
  // Under one second of activity: the window is clamped to 1 s, not 5 s.
  assert.ok(
    liveTps >= succeeded,
    `liveTps ${liveTps} for ${succeeded} receipts`,
  );
});

test("a backend outage pauses sending and polling, then the spray resumes", async (t) => {
  let down = true;
  let polls = 0;
  const engine = fixture(
    {
      async poll(ops) {
        polls++;
        return ops.map(() =>
          down
            ? {
                state: "unavailable" as const,
                message:
                  "Receipt RPC: backend unavailable: indexer not connected",
              }
            : { state: "succeeded" as const, height: "10" },
        );
      },
    },
    { firstPollMs: 0, receiptTimeoutMs: 200 },
  );
  t.after(() => engine.close());
  await ready(engine);
  engine.spray("a", { x: 0.5, y: 0.5 });
  await waitFor(() => polls > 0);
  const attempted = engine.snapshot().attempted;
  const pollsAtOutage = polls;
  // Inside the first 1 s pause: no new transfers, no new polls, no deadline settles.
  await sleep(500);
  assert.equal(engine.snapshot().attempted, attempted);
  assert.ok(polls - pollsAtOutage <= 2);
  assert.equal(engine.snapshot().unresolved, 0);
  down = false;
  await waitFor(() => engine.snapshot().succeeded >= attempted, 5000);
  engine.stop("a");
  await waitFor(() => engine.snapshot().phase === "ready", 5000);
  assert.equal(engine.snapshot().failed, 0);
  assert.equal(engine.snapshot().unresolved, 0);
});
