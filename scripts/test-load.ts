import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import {
  WALLET_COUNT,
  defaults,
  type ServerMessage,
  type Snapshot,
} from "../shared/protocol.js";

const url = process.env.APP_URL ?? "http://127.0.0.1:5177";
const duration = Number(process.env.LOAD_SECONDS ?? 10) * 1000;
assert.ok(
  Number.isFinite(duration) && duration >= 1000 && duration <= 300_000,
  "LOAD_SECONDS must be between 1 and 300",
);
const ws = new WebSocket(url.replace(/^http/, "ws") + "/live");
const errors: string[] = [];
ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString()) as ServerMessage;
  if (message.type === "error") errors.push(message.message);
});
await once(ws, "open");
// A closed socket stops heartbeats and ends the spray; the run would look short, not failed.
ws.on("close", (code) => errors.push(`WebSocket closed (${code})`));
const state = async (): Promise<Snapshot> =>
  (await fetch(`${url}/api/state`)).json() as Promise<Snapshot>;
async function until(predicate: (snapshot: Snapshot) => boolean) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    assert.deepEqual(errors, []);
    await sleep(100);
  }
  throw new Error(`Load run timed out: ${JSON.stringify(await state())}`);
}
const send = (message: unknown) => ws.send(JSON.stringify(message));
const target = {
  batchSize: Number(process.env.LOAD_BATCH ?? defaults.batchSize),
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? defaults.concurrency),
};
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  const current = await until((s) => s.phase === "ready");
  if (
    current.settings.batchSize !== target.batchSize ||
    current.settings.concurrency !== target.concurrency
  ) {
    send({
      type: "configure",
      settings: target,
    });
  }
  await until(
    (s) =>
      s.phase === "ready" &&
      s.settings.batchSize === target.batchSize &&
      s.settings.concurrency === target.concurrency,
  );
  send({ type: "reset" });
  await until((s) => s.attempted === 0);
  const spray = () => send({ type: "spray", point: { x: 0.5, y: 0.5 } });
  spray();
  heartbeat = setInterval(spray, 250);
  await sleep(duration);
  clearInterval(heartbeat);
  send({ type: "stop" });
  const result = await until(
    (s) => s.phase === "ready" && s.pending === 0 && s.attempted > 0,
  );
  assert.equal(result.failed, 0);
  assert.equal(result.unresolved, 0);
  assert.equal(result.succeeded, result.attempted);
  assert.equal(result.walletCount, WALLET_COUNT);
  assert.equal(result.addresses.length, WALLET_COUNT);
  console.log(
    JSON.stringify({
      wallets: result.walletCount,
      succeeded: result.succeeded,
      averageTps: Math.round(result.averageTps),
      elapsedMs: Math.round(result.elapsedMs),
      failed: result.failed,
      unresolved: result.unresolved,
    }),
  );
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/load-run.json",
    JSON.stringify(
      { date: new Date().toISOString(), durationMs: duration, result },
      null,
      2,
    ) + "\n",
  );
} finally {
  clearInterval(heartbeat);
  ws.removeAllListeners("close");
  ws.close();
}
