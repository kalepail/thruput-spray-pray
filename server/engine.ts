import { EventEmitter } from "node:events";
import { publicErrorMessage } from "./errors.js";
import type { Chain, Operation } from "./chain.js";
import {
  defaults,
  WALLET_COUNT,
  type Point,
  type Settings,
  type Snapshot,
} from "../shared/protocol.js";

interface Pending {
  operation: Operation;
  sentAt: number;
  nextPoll: number;
  ready: boolean;
}
export class Engine extends EventEmitter {
  settings = { ...defaults };
  phase: Snapshot["phase"] = "connecting";
  message = "Connecting to Thruput";
  owner: string | null = null;
  private point: Point = { x: 0.5, y: 0.5 };
  private heartbeat = 0;
  private generation = 0;
  private inFlight = 0;
  private reserved = 0;
  private polling = 0;
  private closed = false;
  private pending = new Map<string, Pending>();
  private counts = {
    attempted: 0,
    accepted: 0,
    succeeded: 0,
    failed: 0,
    unresolved: 0,
  };
  private errors: string[] = [];
  private samples: { time: number; sent: number; succeeded: number }[] = [];
  private elapsed = 0;
  private successfulBlocks = new Set<string>();
  private receiptTimeMs = 0;
  private receiptCount = 0;
  private workStart: number | null = null;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private chain: Chain,
    private limits = {
      outstanding: 8192,
      receiptTimeoutMs: 60_000,
      leaseMs: 1500,
    },
  ) {
    super();
    this.timer = setInterval(() => {
      if (this.owner && Date.now() - this.heartbeat > limits.leaseMs)
        this.stop(this.owner);
      this.pump();
      this.poll();
      this.finishWork();
      this.emit("state", this.snapshot());
    }, 100);
  }

  async configure(settings: Settings): Promise<void> {
    if (
      this.closed ||
      this.owner ||
      this.pending.size ||
      this.inFlight ||
      this.phase === "funding"
    )
      throw new Error(
        "Wait for the current spray to drain before changing settings",
      );
    this.phase = "funding";
    try {
      await this.chain.setup(WALLET_COUNT, (message) => {
        this.message = message;
        this.emit("state", this.snapshot());
      });
      this.settings = { ...settings };
      this.phase = "ready";
      this.message = "Ready to spray";
    } catch (error) {
      this.phase = "error";
      this.message = this.recordError(error);
      throw error;
    }
    this.emit("state", this.snapshot());
  }

  spray(id: string, point: Point): void {
    if (this.closed || !["ready", "spraying", "draining"].includes(this.phase))
      throw new Error(this.message);
    if (this.owner && this.owner !== id)
      throw new Error(
        "Another browser is spraying. Try again when it finishes.",
      );
    this.owner = id;
    this.point = point;
    this.heartbeat = Date.now();
    this.workStart ??= performance.now();
    this.phase = "spraying";
    this.message = "Spraying real ERC20 transfers";
    this.pump();
  }

  stop(id: string): void {
    if (this.owner !== id) return;
    this.owner = null;
    this.generation++;
    this.phase = "draining";
    this.message = "Waiting for transaction receipts";
    this.finishWork();
  }

  reset(): void {
    if (
      this.owner ||
      this.pending.size ||
      this.inFlight ||
      this.phase !== "ready"
    )
      throw new Error("Wait for all pending transfers before resetting");
    this.counts = {
      attempted: 0,
      accepted: 0,
      succeeded: 0,
      failed: 0,
      unresolved: 0,
    };
    this.samples = [];
    this.errors = [];
    this.elapsed = 0;
    this.successfulBlocks.clear();
    this.receiptTimeMs = 0;
    this.receiptCount = 0;
  }

  snapshot(): Snapshot {
    const now = Date.now();
    this.samples = this.samples.filter((sample) => now - sample.time < 5000);
    const elapsedMs =
      this.elapsed +
      (this.workStart === null ? 0 : performance.now() - this.workStart);
    return {
      phase: this.phase,
      message: this.message,
      settings: this.settings,
      walletCount: WALLET_COUNT,
      owner: this.owner,
      ...this.counts,
      pending: this.pending.size,
      liveTps: this.samples.reduce((n, s) => n + s.succeeded, 0) / 5,
      submitTps: this.samples.reduce((n, s) => n + s.sent, 0) / 5,
      averageTps: elapsedMs ? (this.counts.succeeded * 1000) / elapsedMs : 0,
      averageTxPerBlock: this.successfulBlocks.size
        ? this.counts.succeeded / this.successfulBlocks.size
        : 0,
      observedBlocks: this.successfulBlocks.size,
      pendingLimit: this.limits.outstanding,
      averageReceiptMs: this.receiptCount
        ? this.receiptTimeMs / this.receiptCount
        : 0,
      elapsedMs,
      backpressure:
        this.owner !== null &&
        this.pending.size + this.reserved + this.settings.batchSize >
          this.limits.outstanding,
      errors: [...this.errors],
      network: this.chain.network,
      addresses: this.chain.addresses.slice(0, WALLET_COUNT),
    };
  }

  private pump(): void {
    while (
      !this.closed &&
      this.owner &&
      this.inFlight < this.settings.concurrency &&
      this.pending.size + this.reserved + this.settings.batchSize <=
        this.limits.outstanding
    ) {
      this.inFlight++;
      this.reserved += this.settings.batchSize;
      void this.send(this.generation);
    }
  }

  private async send(generation: number): Promise<void> {
    const batchSize = this.settings.batchSize;
    let preparing = true;
    try {
      const operations = await this.chain.prepare(
        this.settings.batchSize,
        WALLET_COUNT,
      );
      this.reserved -= batchSize;
      preparing = false;
      if (this.closed || !this.owner || generation !== this.generation) return;
      const sentAt = Date.now();
      const hashes = new Set(operations.map((operation) => operation.hash));
      if (
        hashes.size !== operations.length ||
        operations.some((operation) => this.pending.has(operation.hash))
      ) {
        throw new Error("Duplicate prepared transaction hash");
      }
      for (const operation of operations) {
        this.pending.set(operation.hash, {
          operation,
          sentAt,
          nextPoll: sentAt + 300,
          ready: false,
        });
      }
      this.counts.attempted += operations.length;
      this.samples.push({
        time: sentAt,
        sent: operations.length,
        succeeded: 0,
      });
      this.emit("particles", {
        count: operations.length,
        point: { ...this.point },
        sequence: this.counts.attempted,
      });
      try {
        const outcomes = await this.chain.submit(operations);
        for (let i = 0; i < operations.length; i++) {
          const hash = operations[i]!.hash;
          if (outcomes[i] === "accepted") this.counts.accepted++;
          else if (outcomes[i] === "rejected") {
            this.settle(hash, "failed");
            this.recordError("RPC rejected a transfer before admission");
          } else
            this.recordError(
              "Submission response was ambiguous; checking the original hash",
            );
        }
      } catch (error) {
        this.recordError(error);
      } finally {
        for (const op of operations) {
          const item = this.pending.get(op.hash);
          if (item) item.ready = true;
        }
      }
    } catch (error) {
      this.recordError(error);
      if (this.owner) this.stop(this.owner);
    } finally {
      if (preparing) this.reserved -= batchSize;
      this.inFlight--;
      this.finishWork();
      // Keep the submission pipeline full without tying throughput to telemetry ticks.
      // An event-loop yield lets stop messages and receipt polling run between batches.
      setImmediate(() => this.pump());
    }
  }

  private poll(): void {
    if (this.closed) return;
    while (this.polling < 4) {
      const now = Date.now();
      const batch: Pending[] = [];
      for (const item of this.pending.values()) {
        if (item.ready && item.nextPoll <= now) {
          batch.push(item);
          item.nextPoll = Infinity;
          if (batch.length === 256) break;
        }
      }
      if (batch.length === 0) break;
      this.polling++;
      void this.pollBatch(batch);
    }
  }

  private async pollBatch(batch: Pending[]): Promise<void> {
    try {
      const outcomes = await this.chain.poll(batch.map((p) => p.operation));
      outcomes.forEach((outcome, i) => {
        if (outcome?.state === "unavailable") this.recordError(outcome.message);
        else if (outcome)
          this.settle(batch[i]!.operation.hash, outcome.state, outcome.height);
      });
    } catch (error) {
      this.recordError(error);
    } finally {
      for (const item of batch) {
        if (!this.pending.has(item.operation.hash)) continue;
        if (Date.now() - item.sentAt > this.limits.receiptTimeoutMs) {
          this.settle(item.operation.hash, "unresolved");
          this.recordError("Receipt deadline reached; outcome unresolved");
        } else {
          item.nextPoll = Date.now() + 500;
        }
      }
      this.polling--;
      this.finishWork();
      // Each slot refills independently; a slow RPC cannot hold the other three idle.
      setImmediate(() => {
        this.poll();
        this.pump();
      });
    }
  }

  private settle(
    hash: string,
    outcome: "succeeded" | "failed" | "unresolved",
    height?: string,
  ): void {
    const pending = this.pending.get(hash);
    if (!pending) return;
    this.pending.delete(hash);
    this.counts[outcome]++;
    if (height !== undefined) {
      this.receiptTimeMs += Date.now() - pending.sentAt;
      this.receiptCount++;
    }
    if (outcome === "succeeded") {
      if (height !== undefined) this.successfulBlocks.add(height);
      const last = this.samples.at(-1);
      if (last && Date.now() - last.time < 50) last.succeeded++;
      else this.samples.push({ time: Date.now(), sent: 0, succeeded: 1 });
    }
    if (outcome === "failed")
      this.recordError(
        "Transfer rejected or execution failed; see outcome totals",
      );
  }

  private finishWork(): void {
    if (this.owner || this.inFlight || this.pending.size) return;
    if (this.workStart !== null) {
      this.elapsed += performance.now() - this.workStart;
      this.workStart = null;
    }
    if (this.phase === "draining") {
      this.phase = "ready";
      this.message = "Ready to spray";
    }
  }

  private recordError(error: unknown): string {
    const message = publicErrorMessage(error);
    if (this.errors.at(-1) !== message)
      this.errors = [...this.errors.slice(-7), message];
    return message;
  }

  close(): void {
    this.closed = true;
    if (this.owner) this.stop(this.owner);
    clearInterval(this.timer);
  }
}
