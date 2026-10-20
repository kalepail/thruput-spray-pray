import { DurableObject, env } from "cloudflare:workers";
import { defaults, type ServerMessage } from "../shared/protocol.js";
import { commandSchema, settingsSchema } from "../server/commands.js";
import { thruputChain } from "../server/chain.js";
import { Engine, engineLimits } from "../server/engine.js";
import { networkConfig } from "../server/network.js";
import { publicErrorMessage } from "../server/errors.js";
import { demoSigner } from "../server/signer.js";
import { socketPool } from "../server/socket-rpc.js";

const VERSION_HEADER = "x-spray-pray-version";
// Without visitors or work for this long, the engine stops and the object can be evicted.
// The next visitor re-derives the same four wallets; statistics start fresh.
const IDLE_MS = 30 * 60_000;
// Bump to choose a new engine object, for example after a devnet RPC move.
const ENGINE_PREFIX = "engine-v1";
// Candidates with this round trip to the RPC are beside devnet (SEA or PDX for us-west-2).
const NEAR_RPC_MS = 15;
const MAX_CANDIDATES = 32;

interface Host {
  colo: string;
  rpcRttMs: number;
}

async function measureHost(rpcUrl: string): Promise<Host> {
  const trace = await (
    await fetch("https://cloudflare.com/cdn-cgi/trace")
  ).text();
  const samples: number[] = [];
  for (let i = 0; i < 4; i++) {
    const start = Date.now();
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"groundhog_networkInfo","params":[]}',
    });
    await response.arrayBuffer();
    samples.push(Date.now() - start);
  }
  // Drop the first sample: it includes the TLS handshake.
  const warm = samples.slice(1).sort((a, b) => a - b);
  return {
    colo: /colo=(\w+)/.exec(trace)?.[1] ?? "unknown",
    rpcRttMs: warm[1]!,
  };
}

/** The shared experiment: one engine, its wallets, and every browser's WebSocket. */
export class SprayPray extends DurableObject<Env> {
  private engine?: Engine;
  private host?: Promise<Host>;
  private lastActive = Date.now();
  private idleTimer?: ReturnType<typeof setInterval>;
  private timing?: unknown;

  /** Where this object runs and how far it is from the RPC. Placement uses it to choose. */
  probe(): Promise<Host> {
    return (this.host ??= measureHost(this.env.THRUPUT_RPC_URL).catch(
      (error: unknown) => {
        this.host = undefined;
        throw error;
      },
    ));
  }

  private start(): Engine {
    if (this.engine) return this.engine;
    const vars = this.env as unknown as Record<string, unknown>;
    const sockets = Number(vars.SPRAY_RPC_SOCKETS ?? 0);
    const chain = thruputChain(networkConfig(this.env), {
      post: sockets
        ? socketPool(this.env.THRUPUT_RPC_URL, sockets).post
        : undefined,
    });
    // TEMPORARY: per-stage timing.
    const timing: Record<string, { n: number; ms: number; max: number; active: number; peak: number }> = {};
    for (const key of ["prepare", "submit", "poll"] as const) {
      const inner = chain[key].bind(chain) as (...args: never[]) => Promise<unknown>;
      const t = (timing[key] = { n: 0, ms: 0, max: 0, active: 0, peak: 0 });
      (chain as unknown as Record<string, unknown>)[key] = async (...args: never[]) => {
        const start = Date.now();
        t.active++;
        t.peak = Math.max(t.peak, t.active);
        try {
          return await inner(...args);
        } finally {
          const ms = Date.now() - start;
          t.active--;
          t.n++;
          t.ms += ms;
          t.max = Math.max(t.max, ms);
        }
      };
    }
    this.timing = timing;
    const engine = new Engine(chain, engineLimits(vars));
    engine.on("state", (state) => this.broadcast({ type: "state", state }));
    engine.on("particles", (event) =>
      this.broadcast({ type: "particles", ...event }),
    );
    const starting = settingsSchema.parse({
      batchSize: Number(vars.SPRAY_BATCH_SIZE ?? defaults.batchSize),
      concurrency: Number(vars.SPRAY_CONCURRENCY ?? defaults.concurrency),
    });
    void engine
      .configure(starting)
      .catch((error: unknown) =>
        console.error("Setup:", publicErrorMessage(error)),
      );
    this.idleTimer = setInterval(() => this.stopIfIdle(), 60_000);
    return (this.engine = engine);
  }

  private stopIfIdle(): void {
    const engine = this.engine;
    if (!engine) return;
    const state = engine.snapshot();
    const busy =
      this.ctx.getWebSockets().length > 0 ||
      state.owner !== null ||
      state.pending > 0 ||
      state.phase === "funding" ||
      state.phase === "draining";
    if (busy) this.lastActive = Date.now();
    else if (Date.now() - this.lastActive > IDLE_MS) {
      engine.close();
      if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
      this.engine = undefined;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    // Running timers keep an object alive across deploys. Reset when the Worker in front
    // is newer, so the next request starts the current code.
    const version = request.headers.get(VERSION_HEADER);
    if (version && version !== this.env.VERSION.id) {
      for (const ws of this.ctx.getWebSockets())
        ws.close(1012, "Service restart");
      this.ctx.abort("Worker version changed");
    }
    const engine = this.start();
    this.lastActive = Date.now();
    if (new URL(request.url).pathname === "/api/bench") {
      // TEMPORARY: signing cost in this object.
      const chain = thruputChain(networkConfig(this.env));
      await chain.setup(4, () => {});
      await chain.prepare(256, 4);
      const out: Record<string, number> = {};
      for (const [n, parallel] of [[4096, 1], [4096, 16]] as const) {
        const t = Date.now();
        await Promise.all(
          Array.from({ length: parallel }, async () => {
            for (let done = 0; done < n / parallel; done += 256) await chain.prepare(256, 4);
          }),
        );
        await fetch("https://cloudflare.com/cdn-cgi/trace");
        out[`prepare${n}_p${parallel}`] = Date.now() - t;
      }
      const tick = () => fetch("https://cloudflare.com/cdn-cgi/trace");
      const signer = await demoSigner(0);
      const msg = new Uint8Array(200).fill(7);
      let t = Date.now();
      for (let i = 0; i < 4096; i++) await signer.sign(msg);
      await tick();
      out.sign4096_seq = Date.now() - t;
      t = Date.now();
      await Promise.all(Array.from({ length: 4096 }, () => signer.sign(msg)));
      await tick();
      out.sign4096_all = Date.now() - t;
      const key = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]) as CryptoKeyPair;
      t = Date.now();
      for (let i = 0; i < 4096; i++) await crypto.subtle.sign("Ed25519", key.privateKey, msg);
      await tick();
      out.rawSign4096_seq = Date.now() - t;
      t = Date.now();
      for (let i = 0; i < 4096; i++) await crypto.subtle.digest("SHA-256", msg);
      await tick();
      out.digest4096_seq = Date.now() - t;
      t = Date.now();
      let x = 0;
      for (let i = 0; i < 4096 * 2000; i++) x = (x + i * 7) % 1000003;
      await tick();
      out.spin8M = Date.now() - t + (x < 0 ? 1 : 0);
      return Response.json(out);
    }
    if (new URL(request.url).pathname === "/live") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server!, [crypto.randomUUID()]);
      this.send(server!, { type: "hello", id: this.idOf(server!) });
      this.send(server!, { type: "state", state: engine.snapshot() });
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json(
      {
        ...engine.snapshot(),
        exportedAt: new Date().toISOString(),
        host: await this.probe().catch(() => undefined),
        timing: this.timing,
        measurement:
          "Successful committed receipts observed by this Durable Object; experiment throughput, not global network TPS",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const engine = this.start();
    const id = this.idOf(ws);
    try {
      if (typeof raw !== "string" || raw.length > 4096)
        throw new Error("Invalid message");
      const command = commandSchema.parse(JSON.parse(raw));
      switch (command.type) {
        case "spray":
          engine.spray(id, command.point);
          break;
        case "stop":
          engine.stop(id);
          break;
        case "configure":
          await engine.configure(command.settings);
          break;
        case "reset":
          engine.reset();
          break;
      }
      this.send(ws, { type: "state", state: engine.snapshot() });
    } catch (error) {
      this.send(ws, { type: "error", message: publicErrorMessage(error) });
    }
  }

  override webSocketClose(ws: WebSocket) {
    this.engine?.stop(this.idOf(ws));
  }

  override webSocketError(ws: WebSocket) {
    this.engine?.stop(this.idOf(ws));
  }

  private idOf(ws: WebSocket): string {
    return this.ctx.getTags(ws)[0]!;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // A socket that closed mid-broadcast is cleaned up by webSocketClose.
    }
  }

  private broadcast(message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // See send().
      }
    }
  }
}

/**
 * Chooses, once, which SprayPray object hosts the experiment.
 *
 * Every batch carries ~160 KB to the RPC in AWS us-west-2. From a distant data center
 * those uploads are an order of magnitude slower, and Durable Objects do not move after
 * creation. A `wnam` hint lands anywhere in Western North America, so this creates
 * candidates until one is beside the RPC, then remembers its name.
 */
export class Placement extends DurableObject<Env> {
  private choosing?: Promise<string>;

  engineName(): Promise<string> {
    const chosen = this.ctx.storage.kv.get<string>(ENGINE_PREFIX);
    if (chosen) return Promise.resolve(chosen);
    return (this.choosing ??= this.choose().finally(() => {
      this.choosing = undefined;
    }));
  }

  private async choose(): Promise<string> {
    let best: (Host & { name: string }) | undefined;
    for (let next = 0; next < MAX_CANDIDATES; next += 8) {
      const round = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          const name = `${ENGINE_PREFIX}-${next + i}`;
          const host = await engineStub(name)
            .probe()
            .catch(() => undefined);
          return host && { name, ...host };
        }),
      );
      for (const candidate of round)
        if (candidate && (!best || candidate.rpcRttMs < best.rpcRttMs))
          best = candidate;
      if (best && best.rpcRttMs <= NEAR_RPC_MS) break;
    }
    if (!best) throw new Error("No engine candidate could reach the RPC");
    console.log(
      `Engine ${best.name} in ${best.colo}, ${best.rpcRttMs} ms to RPC`,
    );
    this.ctx.storage.kv.put(ENGINE_PREFIX, best.name);
    return best.name;
  }
}

function engineStub(name: string) {
  const ns = env.SPRAY_PRAY as DurableObjectNamespace<SprayPray>;
  // Only the first get() for a name sets its location.
  return ns.get(ns.idFromName(name), { locationHint: "wnam" });
}

let engineName: Promise<string> | undefined;
function engine() {
  engineName ??= (env.PLACEMENT as DurableObjectNamespace<Placement>)
    .getByName("placement")
    .engineName()
    .catch((error: unknown) => {
      engineName = undefined;
      throw error;
    });
  return engineName.then(engineStub);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const live = pathname === "/live";
    if (
      !live &&
      pathname !== "/api/state" &&
      pathname !== "/api/export" &&
      pathname !== "/api/bench"
    )
      return env.ASSETS.fetch(request);
    if (live) {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("Expected WebSocket", { status: 426 });
      if (!sameOrigin(request)) return new Response(null, { status: 403 });
    }
    const forwarded = new Request(request);
    forwarded.headers.set(VERSION_HEADER, env.VERSION.id);
    const stub = await engine();
    try {
      return await stub.fetch(forwarded.clone());
    } catch {
      // The object reset for a new version; a fresh stub reaches the new instance.
      return (await engine()).fetch(forwarded);
    }
  },
} satisfies ExportedHandler<Env>;
