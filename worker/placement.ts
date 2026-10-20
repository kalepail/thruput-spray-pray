import { DurableObject, env } from "cloudflare:workers";
import type { SprayLane } from "./lane.js";

// Bump to choose new lane objects, for example after the devnet RPC moves.
const LAYOUT_KEY = "lanes-v1";
// Lanes this close to the RPC are beside devnet (SEA or PDX for AWS us-west-2).
const NEAR_RPC_MS = 15;
const MAX_CANDIDATES = 64;

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
  private choosing?: Promise<string[]>;

  lanes(count: number): Promise<string[]> {
    const chosen = this.ctx.storage.kv.get<string[]>(LAYOUT_KEY);
    if (chosen && chosen.length >= count)
      return Promise.resolve(chosen.slice(0, count));
    return (this.choosing ??= this.choose(count).finally(() => {
      this.choosing = undefined;
    }));
  }

  private async choose(count: number): Promise<string[]> {
    const found: { name: string; colo: string; rpcRttMs: number }[] = [];
    for (let next = 0; next < MAX_CANDIDATES; next += 8) {
      const round = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          const name = `${LAYOUT_KEY}-${next + i}`;
          const host = await laneStub(name)
            .probe()
            .catch(() => undefined);
          return host && { name, ...host };
        }),
      );
      for (const candidate of round) if (candidate) found.push(candidate);
      found.sort((a, b) => a.rpcRttMs - b.rpcRttMs);
      if (found.filter((c) => c.rpcRttMs <= NEAR_RPC_MS).length >= count) break;
    }
    if (found.length < count)
      throw new Error("Not enough lane candidates could reach the RPC");
    const lanes = found.slice(0, count);
    console.log(
      "Lanes:",
      lanes.map((l) => `${l.name} ${l.colo} ${l.rpcRttMs} ms`).join(", "),
    );
    const names = lanes.map((l) => l.name);
    this.ctx.storage.kv.put(LAYOUT_KEY, names);
    return names;
  }
}
