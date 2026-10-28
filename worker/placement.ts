import { DurableObject, env } from "cloudflare:workers";
import type { SprayPray } from "./coordinator.js";
import type { Host } from "./host.js";
import type { SprayLane } from "./lane.js";

// Bump to choose new objects, for example after the Futurenet RPC moves.
const LAYOUT_KEY = "lanes-v1";
const COORDINATOR_KEY = "coordinator-v1";
// Lanes this close to the RPC are beside Futurenet (SEA or PDX for AWS us-west-2).
const NEAR_RPC_MS = 15;
const MAX_CANDIDATES = 64;

export function coordinatorStub(name: string) {
  const ns = env.SPRAY_PRAY as DurableObjectNamespace<SprayPray>;
  return ns.get(ns.idFromName(name), { locationHint: "wnam" });
}

export function laneStub(name: string) {
  const ns = env.SPRAY_LANE as DurableObjectNamespace<SprayLane>;
  // Only the first get() for a name sets its location.
  return ns.get(ns.idFromName(name), { locationHint: "wnam" });
}

/**
 * Chooses, once, which SprayLane objects run the experiment.
 *
 * Every batch carries ~150 KB to the RPC in AWS us-west-2. From a distant data center
 * those uploads are an order of magnitude slower, and Durable Objects do not move after
 * creation. A `wnam` hint lands anywhere in Western North America, so this creates
 * candidates until enough are beside the RPC, then remembers their names.
 */
export class Placement extends DurableObject<Env> {
  private choosing = new Map<string, Promise<string[]>>();

  lanes(count: number): Promise<string[]> {
    return this.pick(LAYOUT_KEY, count, (name) => laneStub(name).probe());
  }

  /**
   * The coordinator relays every particle and heartbeat between browsers and lanes,
   * so it belongs beside the lanes too; a distant one added ~200 ms to each click.
   */
  async coordinator(): Promise<string> {
    const [name] = await this.pick(COORDINATOR_KEY, 1, (name) =>
      coordinatorStub(name).probe(),
    );
    return name!;
  }

  private pick(
    key: string,
    count: number,
    probe: (name: string) => Promise<Host>,
  ): Promise<string[]> {
    const chosen = this.ctx.storage.kv.get<string[]>(key);
    if (chosen && chosen.length >= count)
      return Promise.resolve(chosen.slice(0, count));
    let choosing = this.choosing.get(key);
    if (!choosing) {
      choosing = this.choose(key, count, probe).finally(() =>
        this.choosing.delete(key),
      );
      this.choosing.set(key, choosing);
    }
    return choosing;
  }

  private async choose(
    key: string,
    count: number,
    probe: (name: string) => Promise<Host>,
  ): Promise<string[]> {
    const found: { name: string; colo: string; rpcRttMs: number }[] = [];
    for (let next = 0; next < MAX_CANDIDATES; next += 8) {
      const round = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          const name = `${key}-${next + i}`;
          const host = await probe(name).catch(() => undefined);
          return host && { name, ...host };
        }),
      );
      for (const candidate of round) if (candidate) found.push(candidate);
      found.sort((a, b) => a.rpcRttMs - b.rpcRttMs);
      if (found.filter((c) => c.rpcRttMs <= NEAR_RPC_MS).length >= count) break;
    }
    if (found.length < count)
      throw new Error(`Not enough ${key} candidates could reach the RPC`);
    const picked = found.slice(0, count);
    console.log(
      `${key}:`,
      picked.map((c) => `${c.name} ${c.colo} ${c.rpcRttMs} ms`).join(", "),
    );
    const names = picked.map((c) => c.name);
    this.ctx.storage.kv.put(key, names);
    return names;
  }
}
