import { DurableObject } from "cloudflare:workers";
import type { Point, Settings, Snapshot } from "../shared/protocol.js";
import { thruputChain } from "../server/chain.js";
import { Engine, engineLimits } from "../server/engine.js";
import { networkConfig } from "../server/network.js";
import { socketPool } from "../server/socket-rpc.js";
import { isNewerVersion, measureHost, type Host } from "./host.js";

// The coordinator reports every 100 ms while it runs. Without reports, stop the engine
// so the object can be evicted.
const ORPHAN_MS = 2 * 60_000;
const OWNER = "coordinator";

export interface LaneReport {
  snapshot: Snapshot;
  receiptTimeMs: number;
  receiptCount: number;
  /** Heights with successful transfers first seen since the previous report. */
  newBlocks: string[];
  /** Transfers attempted since the previous report, for particles. */
  particles: number;
}

/**
 * One shard of the experiment: signs, submits, and polls for one sender wallet.
 * One isolate signs on one core, so the coordinator spreads work across lanes.
 */
export class SprayLane extends DurableObject<Env> {
  private engine?: Engine;
  private host?: Promise<Host>;
  private particles = 0;
  private reportedBlocks = 0;
  private lastReport = Date.now();
  private orphanTimer?: ReturnType<typeof setInterval>;

  probe(): Promise<Host> {
    return (this.host ??= measureHost(this.env.THRUPUT_RPC_URL).catch(
      (error: unknown) => {
        this.host = undefined;
        throw error;
      },
    ));
  }

  private checkVersion(version: string) {
    if (isNewerVersion(version, this.env.VERSION.timestamp))
      this.ctx.abort("Worker version changed");
  }

  /** Starts the engine for this lane's sender if needed, then applies settings and funds it. */
  async configure(
    version: string,
    lane: { sender: number; slot: number; slots: number },
    settings: Settings,
    outstanding: number,
  ): Promise<void> {
    this.checkVersion(version);
    this.lastReport = Date.now();
    if (!this.engine) {
      const vars = this.env as unknown as Record<string, unknown>;
      const sockets = Number(vars.SPRAY_RPC_SOCKETS ?? 0);
      const engine = new Engine(
        thruputChain(networkConfig(this.env), {
          senders: [lane.sender],
          slot: lane.slot,
          slots: lane.slots,
          walletSeed:
            (vars.SPRAY_WALLET_SEED as string | undefined) || undefined,
          post: sockets
            ? socketPool(this.env.THRUPUT_RPC_URL, sockets).post
            : undefined,
        }),
        { ...engineLimits(vars), outstanding },
      );
      engine.on("particles", ({ count }) => (this.particles += count));
      this.engine = engine;
      this.orphanTimer = setInterval(() => {
        if (Date.now() - this.lastReport > ORPHAN_MS) this.close();
      }, 30_000);
    }
    await this.engine.configure(settings);
  }

  spray(version: string, point: Point): void {
    this.checkVersion(version);
    this.lastReport = Date.now();
    this.running().spray(OWNER, point);
  }

  stop(): void {
    this.engine?.stop(OWNER);
  }

  reset(): void {
    this.running().reset();
    this.reportedBlocks = 0;
  }

  /** Null until the coordinator configures this lane, including after a reset. */
  report(version: string): LaneReport | null {
    this.checkVersion(version);
    this.lastReport = Date.now();
    if (!this.engine) return null;
    const totals = this.engine.totals();
    // A stats reset clears the engine's block set.
    if (totals.blocks.length < this.reportedBlocks) this.reportedBlocks = 0;
    const report = {
      snapshot: this.engine.snapshot(),
      receiptTimeMs: totals.receiptTimeMs,
      receiptCount: totals.receiptCount,
      newBlocks: totals.blocks.slice(this.reportedBlocks),
      particles: this.particles,
    };
    this.reportedBlocks = totals.blocks.length;
    this.particles = 0;
    return report;
  }

  private running(): Engine {
    if (!this.engine) throw new Error("Lane is not configured");
    return this.engine;
  }

  private close() {
    this.engine?.close();
    this.engine = undefined;
    if (this.orphanTimer !== undefined) clearInterval(this.orphanTimer);
  }
}
