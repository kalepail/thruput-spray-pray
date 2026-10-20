import { setTimeout as sleep } from "node:timers/promises";
import { Engine } from "../server/engine.js";
import { thruputChain } from "../server/chain.js";
import type { Snapshot } from "../shared/protocol.js";

function summary(state: Snapshot) {
  return {
    network: state.network,
    wallets: state.walletCount,
    attempted: state.attempted,
    succeeded: state.succeeded,
    pending: state.pending,
    failed: state.failed,
    unresolved: state.unresolved,
    averageTps: Math.round(state.averageTps),
    elapsedMs: Math.round(state.elapsedMs),
    observedBlocks: state.observedBlocks,
    averageTxPerBlock: state.averageTxPerBlock,
    averageReceiptMs: Math.round(state.averageReceiptMs),
  };
}

const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
  throw new Error("LOAD_CONCURRENCY must be between 1 and 16");
const chain = thruputChain();
const durations = {
  prepare: [] as number[],
  submit: [] as number[],
  poll: [] as number[],
};
let receiptLookups = 0;
const measured = {
  ...chain,
  async prepare(count: number, wallets: number) {
    const start = performance.now();
    try {
      return await chain.prepare(count, wallets);
    } finally {
      durations.prepare.push(performance.now() - start);
    }
  },
  async submit(operations: Parameters<typeof chain.submit>[0]) {
    const start = performance.now();
    try {
      return await chain.submit(operations);
    } finally {
      durations.submit.push(performance.now() - start);
    }
  },
  async poll(operations: Parameters<typeof chain.poll>[0]) {
    const start = performance.now();
    receiptLookups += operations.length;
    try {
      return await chain.poll(operations);
    } finally {
      durations.poll.push(performance.now() - start);
    }
  },
};
const engine = new Engine(measured);
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  await engine.configure({ batchSize: 128, concurrency });
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const spray = () => engine.spray("profile", { x: 0.5, y: 0.5 });
  spray();
  heartbeat = setInterval(spray, 250);
  await sleep(10_000);
  clearInterval(heartbeat);
  engine.stop("profile");
  const atRelease = engine.snapshot();
  while (engine.snapshot().phase !== "ready") {
    if (performance.now() - start > 90_000)
      throw new Error("Receipt drain timed out");
    await sleep(100);
  }
  const cpu = process.cpuUsage(cpuStart);
  console.log(
    JSON.stringify(
      {
        concurrency,
        atRelease: summary(atRelease),
        drained: summary(engine.snapshot()),
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        receiptLookups,
        batchLatencyMs: Object.fromEntries(
          Object.entries(durations).map(([phase, samples]) => {
            samples.sort((a, b) => a - b);
            return [
              phase,
              {
                calls: samples.length,
                average: Math.round(
                  samples.reduce((a, b) => a + b, 0) / samples.length,
                ),
                p95: Math.round(
                  samples[Math.floor(samples.length * 0.95)] ?? 0,
                ),
              },
            ];
          }),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(heartbeat);
  engine.close();
}
