import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import type { ServerMessage, Snapshot } from "../shared/protocol.js";

// Two browsers share one experiment; only one may spray. Sprays briefly on devnet.
const url = process.env.APP_URL ?? "http://127.0.0.1:5177";
const state = async (): Promise<Snapshot> =>
  (await fetch(`${url}/api/state`)).json() as Promise<Snapshot>;
async function until(predicate: (s: Snapshot) => boolean, what: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (predicate(await state())) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function client() {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/live");
  const errors: string[] = [];
  let id = "";
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;
    if (message.type === "hello") id = message.id;
    if (message.type === "error") errors.push(message.message);
  });
  await once(ws, "open");
  while (!id) await sleep(20);
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  const spray = () => send({ type: "spray", point: { x: 0.5, y: 0.5 } });
  return { ws, errors, id: () => id, send, spray };
}

const a = await client();
const b = await client();
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  await until((s) => s.phase === "ready" && s.owner === null, "ready");
  a.spray();
  heartbeat = setInterval(a.spray, 250);
  await until((s) => s.owner === a.id(), "A to hold the lease");
  b.spray();
  await sleep(1000);
  assert.ok(
    b.errors.some((e) => /Another browser is spraying/.test(e)),
    `B was not refused: ${JSON.stringify(b.errors)}`,
  );
  assert.equal((await state()).owner, a.id());
  clearInterval(heartbeat);
  a.send({ type: "stop" });
  await until((s) => s.owner === null, "A to release");
  b.errors.length = 0;
  b.spray();
  heartbeat = setInterval(b.spray, 250);
  await until((s) => s.owner === b.id(), "B to take the lease");
  clearInterval(heartbeat);
  // Closing the socket must also release the lease.
  b.ws.close();
  await until((s) => s.owner === null, "B's disconnect to release");
  await until((s) => s.phase === "ready" && s.pending === 0, "drain");
  const final = await state();
  assert.equal(final.failed, 0);
  assert.equal(final.unresolved, 0);
  assert.deepEqual(a.errors, []);
  console.log(
    JSON.stringify({
      refusedSecondBrowser: true,
      leaseHandedOver: true,
      releasedOnDisconnect: true,
      succeeded: final.succeeded,
    }),
  );
} finally {
  clearInterval(heartbeat);
  a.ws.close();
  b.ws.close();
}
