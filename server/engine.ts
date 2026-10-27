import { publicErrorMessage, RpcConnectionError } from "./errors.js";
import type { Chain, Operation } from "./chain.js";
import {
  defaults,
  type Point,
  type Settings,
  type Snapshot,
} from "../shared/protocol.js";

export interface EngineLimits {
  outstanding: number;
  /** Wallets in the transfer ring; each sender adds 7,000 transfers per block. */
  wallets: number;
  receiptTimeoutMs: number;
  leaseMs: number;
  pollConcurrency: number;
  pollBatch: number;
  firstPollMs: number;
  firstPollRatio: number;
  pollIntervalMs: number;
  submitRetries: number;
  probeIntervalMs: number;
  statusAfterMs: number;
}

/** A request that never produced an HTTP response: connection failure or timeout. */
export function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof RpcConnectionError ||
    (error instanceof TypeError && error.message === "fetch failed") ||
    // workerd's fetch() reports a dropped connection this way.
    (error instanceof Error && error.message === "Network connection lost.") ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}

/** Longest pause after a backend reports itself unavailable. */
const BACKOFF_MAX_MS = 8_000;

/** The gateway's `-32050` answer: the backend behind it is down, not the transfer. */
export function isBackendUnavailable(message: string): boolean {
  return /backend unavailable|-32050/i.test(message);
}

export function engineLimits(env: Record<string, unknown> = {}): EngineLimits {
  const text = (name: string) => {
    const value = env[name];
    return typeof value === "string" ? value.trim() : undefined;
  };
  const number = (name: string, fallback: number, minimum = 0) => {
    const raw = text(name);
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < minimum)
      throw new Error(`${name} must be an integer of at least ${minimum}`);
    return value;
  };
  const ratio = Number(text("SPRAY_FIRST_POLL_RATIO") || 0);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 2)
    throw new Error("SPRAY_FIRST_POLL_RATIO must be between 0 and 2");
  return {
    outstanding: number("SPRAY_OUTSTANDING", 8192, 1),
    wallets: number("SPRAY_WALLETS", 4, 2),
    receiptTimeoutMs: 60_000,
    leaseMs: 1500,
    pollConcurrency: number("SPRAY_POLL_CONCURRENCY", 4, 1),
    pollBatch: number("SPRAY_POLL_BATCH", 256, 1),
    firstPollMs: number("SPRAY_FIRST_POLL_MS", 300),
    firstPollRatio: ratio,
    pollIntervalMs: number("SPRAY_POLL_INTERVAL_MS", 500, 1),
    submitRetries: number("SPRAY_SUBMIT_RETRIES", 0),
    probeIntervalMs: number("SPRAY_PROBE_INTERVAL_MS", 0),
    // 0 disables scheduler status checks and resends.
    statusAfterMs: number("SPRAY_STATUS_AFTER_MS", 0),
  };
}

export interface EngineEvents {
  state: Snapshot;
  particles: { count: number; point: Point; sequence: number };
}
type Listeners = {
  [K in keyof EngineEvents]: ((value: EngineEvents[K]) => void)[];
};

/** Transfers submitted in one request; they usually commit in the same block. */
interface Group {
  probe: string;
  hashes: string[];
}
interface Pending {
  operation: Operation;
  sentAt: number;
  nextPoll: number;
  ready: boolean;
  group: Group;
  /** Earliest time to ask the scheduler about a missing receipt. */
  statusAt: number;
}
export class Engine {
  private listeners: Listeners = { state: [], particles: [] };
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
  private backoffMs = 0;
  private backoffUntil = 0;
  private closed = false;
  private pending = new Map<string, Pending>();
  private counts = {
    attempted: 0,
    accepted: 0,
    succeeded: 0,
    failed: 0,
    unresolved: 0,
    resubmitted: 0,
  };
  private errors: string[] = [];
  private samples: { time: number; sent: number; succeeded: number }[] = [];
  private elapsed = 0;
  private successfulBlocks = new Set<string>();
  private blockCounts = new Map<string, number>();
  private receiptTimeMs = 0;
  private receiptCount = 0;
  private workStart: number | null = null;
  private timer: ReturnType<typeof setInterval>;

  private limits: EngineLimits;

  constructor(
    private chain: Chain,
    limits: Partial<EngineLimits> = {},
  ) {
    this.limits = { ...engineLimits(), ...limits };
    this.timer = setInterval(() => {
      if (this.owner && Date.now() - this.heartbeat > this.limits.leaseMs)
        this.stop(this.owner);
      this.pump();
      this.poll();
      this.finishWork();
      this.emit("state", this.snapshot());
    }, 100);
  }

  on<K extends keyof EngineEvents>(
    event: K,
    listener: (value: EngineEvents[K]) => void,
  ): void {
    this.listeners[event].push(listener);
  }

  private emit<K extends keyof EngineEvents>(
    event: K,
    value: EngineEvents[K],
  ): void {
    for (const listener of this.listeners[event]) listener(value);
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
      await this.chain.setup(this.limits.wallets, (message) => {
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
      resubmitted: 0,
    };
    this.samples = [];
    this.errors = [];
    this.elapsed = 0;
    this.successfulBlocks.clear();
    this.blockCounts.clear();
    this.receiptTimeMs = 0;
    this.receiptCount = 0;
  }

  /** Totals for combining several engines' statistics exactly. */
  totals() {
    return {
      receiptTimeMs: this.receiptTimeMs,
      receiptCount: this.receiptCount,
      blocks: [...this.successfulBlocks],
    };
  }

  snapshot(): Snapshot {
    const now = Date.now();
    this.samples = this.samples.filter((sample) => now - sample.time < 5000);
    // Rates cover the last 5 s, or less when activity began more recently, so the
    // headline is right from the first receipts instead of ramping for 5 s.
    const windowSeconds = Math.min(
      5,
      Math.max(1, (now - (this.samples[0]?.time ?? now)) / 1000),
    );
    const elapsedMs =
      this.elapsed +
      (this.workStart === null ? 0 : performance.now() - this.workStart);
    return {
      phase: this.phase,
      message: this.message,
      settings: this.settings,
      walletCount: this.limits.wallets,
      owner: this.owner,
      ...this.counts,
      pending: this.pending.size,
      liveTps:
        this.samples.reduce((n, s) => n + s.succeeded, 0) / windowSeconds,
      submitTps: this.samples.reduce((n, s) => n + s.sent, 0) / windowSeconds,
      sendingTps: this.samples
        .filter((sample) => now - sample.time < 1000)
        .reduce((n, s) => n + s.sent, 0),
      recentBlocks: [...this.blockCounts]
        .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .slice(-5)
        .map(([height, succeeded]) => ({ height, succeeded })),
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
      addresses: this.chain.addresses.slice(0, this.limits.wallets),
    };
  }

  private pump(): void {
    while (
      !this.closed &&
      this.owner &&
      Date.now() >= this.backoffUntil &&
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
        this.limits.wallets,
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
      const group: Group = {
        probe: operations[0]!.hash,
        hashes: operations.map((operation) => operation.hash),
      };
      const probing = this.limits.probeIntervalMs > 0;
      for (const operation of operations) {
        const probe = probing && operation.hash === group.probe;
        this.pending.set(operation.hash, {
          operation,
          sentAt,
          // With probing, one transfer per batch is checked often; the rest wait
          // for it to land, with a later first poll as a fallback.
          nextPoll:
            sentAt +
            (probe
              ? this.limits.firstPollMs
              : probing
                ? this.firstPollDelay() * 1.5
                : this.firstPollDelay()),
          ready: false,
          group,
          statusAt: sentAt + this.limits.statusAfterMs,
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
        let outcomes: Awaited<ReturnType<Chain["submit"]>> | undefined;
        for (let attempt = 0; !outcomes; attempt++) {
          try {
            outcomes = await this.chain.submit(operations);
          } catch (error) {
            // A lost connection can hide admission. Resending the identical signed
            // bytes never replaces a transfer, and the gateway answers a duplicate
            // with the same hash. HTTP status and parse errors are not resent.
            if (
              attempt >= this.limits.submitRetries ||
              !isNetworkFailure(error)
            )
              throw error;
            this.recordError(error);
            await new Promise((resolve) =>
              setTimeout(resolve, 250 * (attempt + 1)),
            );
          }
        }
        for (let i = 0; i < operations.length; i++) {
          const hash = operations[i]!.hash;
          if (outcomes[i] === "accepted") this.counts.accepted++;
          // After a resend, a rejection may be the duplicate of an admitted copy.
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
      setTimeout(() => this.pump(), 0);
    }
  }

  private poll(): void {
    if (this.closed || Date.now() < this.backoffUntil) return;
    while (this.polling < this.limits.pollConcurrency) {
      const now = Date.now();
      const batch: Pending[] = [];
      for (const item of this.pending.values()) {
        if (item.ready && item.nextPoll <= now) {
          batch.push(item);
          item.nextPoll = Infinity;
          if (batch.length === this.limits.pollBatch) break;
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
      let down = false;
      outcomes.forEach((outcome, i) => {
        if (outcome?.state === "unavailable") {
          this.recordError(outcome.message);
          down ||= isBackendUnavailable(outcome.message);
        } else if (outcome)
          this.settle(batch[i]!.operation.hash, outcome.state, outcome.height);
      });
      if (down) this.backOff();
      else this.backoffMs = 0;
    } catch (error) {
      if (isBackendUnavailable(this.recordError(error))) this.backOff();
    } finally {
      const overdue: Pending[] = [];
      for (const item of batch) {
        if (!this.pending.has(item.operation.hash)) continue;
        if (
          this.limits.statusAfterMs > 0 &&
          this.chain.status &&
          Date.now() >= item.statusAt
        ) {
          item.statusAt = Infinity;
          overdue.push(item);
        }
        // An outage pauses the deadline; the first poll after it decides the transfer.
        if (
          Date.now() >= this.backoffUntil &&
          Date.now() - item.sentAt > this.limits.receiptTimeoutMs
        ) {
          this.settle(item.operation.hash, "unresolved");
          this.recordError("Receipt deadline reached; outcome unresolved");
        } else {
          item.nextPoll =
            Date.now() +
            (this.limits.probeIntervalMs > 0 &&
            item.group.probe === item.operation.hash
              ? this.limits.probeIntervalMs
              : this.limits.pollIntervalMs);
        }
      }
      if (overdue.length) void this.checkStatus(overdue);
      this.polling--;
      this.finishWork();
      // Each slot refills independently; a slow RPC cannot hold the other three idle.
      setTimeout(() => {
        this.poll();
        this.pump();
      }, 0);
    }
  }

  /**
   * Under load the scheduler excludes transfers that lose a two-phase-commit storage
   * conflict and reports them as `retry`. Resending the identical signed bytes keeps
   * the same hash, so it can never create a second transfer.
   */
  private async checkStatus(items: Pending[]): Promise<void> {
    try {
      const statuses = await this.chain.status!(items.map((i) => i.operation));
      const resend: Pending[] = [];
      statuses.forEach((status, i) => {
        const item = items[i]!;
        if (!this.pending.has(item.operation.hash)) return;
        if (status === "retry" || status === "unknown") resend.push(item);
        else if (status === "dropped") {
          this.settle(item.operation.hash, "failed");
          this.recordError(`Scheduler reported a ${status} transfer`);
        }
      });
      if (resend.length) {
        // Devnet answers a duplicate of an admitted transfer with the same hash, so a
        // rejection here is real.
        const outcomes = await this.chain.submit(
          resend.map((item) => item.operation),
        );
        this.counts.resubmitted += resend.length;
        outcomes.forEach((outcome, i) => {
          if (outcome === "rejected")
            this.settle(resend[i]!.operation.hash, "failed");
        });
      }
    } catch (error) {
      this.recordError(error);
    } finally {
      for (const item of items)
        item.statusAt = Date.now() + this.limits.statusAfterMs;
    }
  }

  /** Skip lookups that would almost certainly miss: most receipts arrive near the observed average. */
  private firstPollDelay(): number {
    const average = this.receiptCount
      ? this.receiptTimeMs / this.receiptCount
      : 0;
    return Math.max(
      this.limits.firstPollMs,
      average * this.limits.firstPollRatio,
    );
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
    if (height !== undefined && pending.group.probe === hash) {
      // The probe landed, so its batch has very likely landed too: poll it now.
      for (const member of pending.group.hashes) {
        const item = this.pending.get(member);
        // Skip members whose lookup is already in flight.
        if (item?.ready && item.nextPoll !== Infinity) item.nextPoll = 0;
      }
    }
    if (outcome === "succeeded") {
      if (height !== undefined) {
        this.successfulBlocks.add(height);
        this.blockCounts.set(height, (this.blockCounts.get(height) ?? 0) + 1);
        if (this.blockCounts.size > 16) {
          const oldest = [...this.blockCounts.keys()].reduce((a, b) =>
            BigInt(a) < BigInt(b) ? a : b,
          );
          this.blockCounts.delete(oldest);
        }
      }
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

  /**
   * Pause sending and polling while a backend is down, doubling up to BACKOFF_MAX_MS.
   * The spray keeps its lease and resumes on the first tick after the pause.
   */
  private backOff(): void {
    this.backoffMs = Math.min(
      Math.max(this.backoffMs * 2, 1_000),
      BACKOFF_MAX_MS,
    );
    this.backoffUntil = Date.now() + this.backoffMs;
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
