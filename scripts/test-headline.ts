import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import type { ServerMessage, Snapshot } from "../shared/protocol.js";

// Sprays with random holds and gaps, so floods differ in size and timing, and checks
// that the headline never reports more than the chain did. The truth is the highest
// rate of our transfers over any run of blocks spanning at least 10 s of chain time
// (`getBlockByHeight` timepoints), independent of the coordinator's tip reads.
const url = process.env.APP_URL ?? "http://127.0.0.1:5177";
const rpcUrl = process.env.RPC_URL ?? "https://rpc.thruput.network";
const seconds = Number(process.env.HEADLINE_SECONDS ?? 120);
assert.ok(seconds >= 10 && seconds <= 600, "HEADLINE_SECONDS must be 10-600");
const seed = Number(process.env.HEADLINE_SEED ?? Date.now() % 1_000_000);
// Allowed excess over the truth, for the gap between Cloudflare and chain clocks.
const margin = Number(process.env.HEADLINE_MARGIN ?? 0.03);
const WINDOW_MS = 10_000;

let state = seed;
const random = () => {
  // mulberry32: a seeded pattern can be replayed with HEADLINE_SEED.
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const between = (low: number, high: number) => low + random() * (high - low);

async function rpc<T>(method: string, params: object): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await response.json()) as { result: T }).result;
}
const snapshot = async (): Promise<Snapshot> =>
  (await fetch(`${url}/api/state`)).json() as Promise<Snapshot>;
async function idle(): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const s = await snapshot();
    if (s.phase === "ready" && s.pending === 0 && !s.owner) return;
    await sleep(1000);
  }
  throw new Error("The app did not become idle");
}

await idle();
const ws = new WebSocket(url.replace(/^http/, "ws") + "/live");
await once(ws, "open");
const errors: string[] = [];
const ours = new Map<string, number>();
const samples: {
  ms: number;
  shown: number;
  kind: "confirmed" | "sending";
}[] = [];
let started = 0;
let holding = false;
let sprayStart: { time: number; attempted: number } | null = null;
let confirmedThisSpray = false;
ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString()) as ServerMessage;
  if (message.type === "error") errors.push(message.message);
  if (message.type !== "state" || !started) return;
  const s = message.state;
  for (const block of s.recentBlocks)
    ours.set(
      block.height,
      Math.max(ours.get(block.height) ?? 0, block.succeeded),
    );
  // The same rule as src/main.ts: sends since the spray started, over at least
  // 10 s, until this spray has a confirmed rate.
  const spraying = s.phase === "spraying";
  if (!spraying) {
    confirmedThisSpray = false;
    sprayStart = null;
  } else {
    sprayStart ??= { time: Date.now(), attempted: s.attempted };
    if (s.liveTps > 0) confirmedThisSpray = true;
  }
  const sending = spraying && !confirmedThisSpray;
  const shown = sending
    ? ((s.attempted - sprayStart!.attempted) * 1000) /
      Math.max(Date.now() - sprayStart!.time, WINDOW_MS)
    : s.liveTps;
  samples.push({
    ms: Date.now() - started,
    shown,
    kind: sending ? "sending" : "confirmed",
  });
});
ws.on("close", (code) => errors.push(`WebSocket closed (${code})`));

const pattern: { holdMs: number; gapMs: number }[] = [];
const tip0 = BigInt(
  (await rpc<{ blockHeight: string }>("getChainTip", {})).blockHeight,
);
started = Date.now();
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  while (Date.now() - started < seconds * 1000) {
    const holdMs = Math.round(between(300, 8000));
    const gapMs = Math.round(between(500, 6000));
    pattern.push({ holdMs, gapMs });
    const point = { x: between(0.1, 0.9), y: between(0.1, 0.9) };
    const spray = () => ws.send(JSON.stringify({ type: "spray", point }));
    holding = true;
    spray();
    heartbeat = setInterval(spray, 250);
    await sleep(holdMs);
    clearInterval(heartbeat);
    ws.send(JSON.stringify({ type: "stop" }));
    holding = false;
    await sleep(gapMs);
  }
} finally {
  clearInterval(heartbeat);
  if (holding) ws.send(JSON.stringify({ type: "stop" }));
}
await idle();
await sleep(12_000);
ws.removeAllListeners("close");
ws.close();

// Chain times; the index may still be storing the last blocks.
const heights = [...ours.keys()].map(BigInt).filter((h) => h > tip0);
assert.ok(heights.length > 0, "No transfers confirmed");
const first = heights.reduce((a, b) => (a < b ? a : b));
const last = heights.reduce((a, b) => (a > b ? a : b));
const times = new Map<bigint, number>();
for (let h = first; h <= last + 1n; h++) {
  for (let attempt = 0; attempt < 30 && !times.has(h); attempt++) {
    const block = await rpc<{ blockTimepoint: string } | null>(
      "getBlockByHeight",
      { blockHeight: String(h) },
    );
    if (block) times.set(h, Number(BigInt(block.blockTimepoint) / 1_000_000n));
    else await sleep(1000);
  }
  assert.ok(times.has(h), `No chain time for block ${h}`);
}
// Highest 10 s rate the chain gave our transfers: any run of blocks a..b, divided
// by its chain time or 10 s, whichever is longer (a shorter run still fits in a 10 s
// window). A block runs from its timepoint to the next block's.
let truth = 0;
let truthRange = "";
for (let a = first; a <= last; a++) {
  let count = 0;
  for (let b = a; b <= last; b++) {
    count += ours.get(String(b)) ?? 0;
    const span = times.get(b + 1n)! - times.get(a)!;
    const rate = (count * 1000) / Math.max(span, WINDOW_MS);
    if (rate > truth) {
      truth = rate;
      truthRange = `${a}-${b}`;
    }
  }
}
const total = [...ours.entries()]
  .filter(([h]) => BigInt(h) > tip0)
  .reduce((n, [, c]) => n + c, 0);
const max = (kind: string) =>
  samples
    .filter((s) => s.kind === kind)
    .reduce((m, s) => (s.shown > m.shown ? s : m), { ms: 0, shown: 0 });
const over = samples.filter((s) => s.shown > truth * (1 + margin));
const result = {
  seed,
  sprays: pattern.length,
  pattern,
  transfers: total,
  blocks: `${first}-${last}`,
  truth10s: Math.round(truth),
  truthRange,
  maxConfirmed: max("confirmed"),
  maxSending: max("sending"),
  samples: samples.length,
  over: over.length,
  worstRatio: truth ? Math.max(...samples.map((s) => s.shown)) / truth : 0,
  overSamples: over.slice(0, 20),
  errors: [...new Set(errors)],
};
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/headline-run.json",
  JSON.stringify(
    { date: new Date().toISOString(), result, samples, ours: [...ours] },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({ ...result, pattern: undefined, overSamples: undefined }),
);
assert.equal(
  over.length,
  0,
  `The headline exceeded the chain's best 10 s rate (${Math.round(truth)}): ${JSON.stringify(over.slice(0, 5))}`,
);
