import { DurableObject, env } from "cloudflare:workers";
import {
  defaults,
  type Point,
  type ServerMessage,
  type Settings,
  type Snapshot,
} from "../shared/protocol.js";
import { commandSchema, settingsSchema } from "../server/commands.js";
import { engineLimits } from "../server/engine.js";
import { publicErrorMessage } from "../server/errors.js";
import { isNewerVersion, measureHost, type Host } from "./host.js";
import type { LaneReport } from "./lane.js";
import { laneStub, type Placement } from "./placement.js";

export const VERSION_HEADER = "x-spray-pray-version";
const LEASE_MS = 1500;
// Lanes need a heartbeat inside their own lease; browsers send one every 250 ms.
const FORWARD_MS = 250;
// Without visitors or work for this long, the coordinator stops reporting and every
// object can be evicted. Statistics start fresh on the next visit.
const IDLE_MS = 30 * 60_000;
const SETUP_RETRY_MS = 5_000;
// Lane batches merge into one particle broadcast per window; see particles().
const PARTICLE_FLUSH_MS = 50;

type Lane = ReturnType<typeof laneStub>;

// A lane call that never settles would otherwise block the caller indefinitely.
const LANE_CALL_MS = 5_000;
// Transfers pending but no new block reported for this long: none are confirming.
const STALL_MS = 6_000;
// While blocks still commit, receipts can lag this long under load before the rate
// is taken as stalled.
const INDEX_LAG_MS = 15_000;
// How often the chain tip is read.
const TIP_READ_MS = 250;
// The headline averages over this much commit time, about one fill-and-wait cycle
// of the in-flight cap at Futurenet's limit.
const RATE_WINDOW_MS = 10_000;
const LANE_CONFIGURE_MS = 120_000;
function deadline<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    call,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Lane did not answer")), ms);
    }),
  ]).finally(() => timer !== null && clearTimeout(timer));
}

/**
 * The shared experiment: browser WebSockets, the single spray lease, and combined
 * statistics. Transfers run in SprayLane objects placed beside the RPC.
 */
export class SprayPray extends DurableObject<Env> {
  private settings: Settings = { ...defaults };
  // Each lane signs on its own core with its own connections; lanes split the wallets.
  private laneCount = 0;
  private wallets = 0;
  private outstanding = 0;
  private rate = 0;
  private lanes?: Promise<Lane[]>;
  private reports: (LaneReport | null)[] = [];
  private configuring?: Promise<void>;
  private setupError?: string;
  private setupFailedAt = 0;
  private owner: string | null = null;
  private point: Point = { x: 0.5, y: 0.5 };
  private heartbeat = 0;
  private forwardedAt = 0;
  private sequence = 0;
  /** Transfers from lane batches not yet sent to browsers as particles. */
  private particleCount = 0;
  private particleTimer?: ReturnType<typeof setTimeout>;
  private blocks = new Set<string>();
  /** Per lane, how many of its block heights this object has merged. */
  private cursors: number[] = [];
  /** When each block height with our transfers was first reported by any lane. */
  private seen = new Map<string, number>();
  private sprayStartedAt = 0;
  /** The chain tip; with nothing pending, it lets the rate fall to zero. */
  private tip = 0n;
  private tipReadAt = 0;
  /** When this object first saw each height as the chain tip, in ms. */
  private tipSeenAt = new Map<string, number>();
  private lastRate = 0;
  /** Highest confirmed headline since the last reset; caps the send rate. */
  private peakRate = 0;
  private errors: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private reportedAt = 0;
  private lastActive = Date.now();

  private start(): void {
    if (this.timer) return;
    const vars = this.env as unknown as Record<string, unknown>;
    this.settings = settingsSchema.parse({
      batchSize: Number(vars.SPRAY_BATCH_SIZE ?? defaults.batchSize),
      concurrency: Number(vars.SPRAY_CONCURRENCY ?? defaults.concurrency),
    });
    const limits = engineLimits(vars);
    this.outstanding = limits.outstanding;
    this.rate = limits.rate;
    this.wallets = limits.wallets;
    this.laneCount = Number(vars.SPRAY_LANES ?? this.wallets);
    if (
      !Number.isInteger(this.laneCount) ||
      this.laneCount < this.wallets ||
      this.laneCount % this.wallets
    )
      throw new Error(`SPRAY_LANES must be a multiple of ${this.wallets}`);
    this.lastActive = Date.now();
    this.timer = setInterval(() => void this.tick(), 100);
    void this.configureLanes(this.settings).catch(() => {});
  }

  private laneStubs(): Promise<Lane[]> {
    return (this.lanes ??= (env.PLACEMENT as DurableObjectNamespace<Placement>)
      .getByName("placement")
      .lanes(this.laneCount, this.version())
      .then((names) => names.map(laneStub))
      .catch((error: unknown) => {
        this.lanes = undefined;
        throw error;
      }));
  }

  /** Lane settings divide the total concurrency, in-flight budget, and send rate between lanes. */
  private laneSettings(settings: Settings) {
    return {
      settings: {
        batchSize: settings.batchSize,
        concurrency: Math.max(
          1,
          Math.ceil(settings.concurrency / this.laneCount),
        ),
      },
      limits: {
        outstanding: Math.floor(this.outstanding / this.laneCount),
        // 0 leaves sending unpaced; any set rate keeps every lane paced.
        rate: this.rate && Math.max(1, Math.floor(this.rate / this.laneCount)),
      },
    };
  }

  private configureLanes(settings: Settings): Promise<void> {
    if (this.configuring)
      return Promise.reject(new Error("Configuration is already running"));
    const { settings: lane, limits } = this.laneSettings(settings);
    this.setupError = undefined;
    const run = (async () => {
      const lanes = await this.laneStubs();
      const results = await Promise.allSettled(
        lanes.map((stub, index) =>
          deadline(
            stub.configure(
              this.version(),
              {
                coordinator: this.ctx.id.name!,
                sender: index % this.wallets,
                slot: Math.floor(index / this.wallets),
                slots: this.laneCount / this.wallets,
              },
              lane,
              limits,
            ),
            LANE_CONFIGURE_MS,
          ),
        ),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
      this.settings = { ...settings };
    })()
      .catch((error: unknown) => {
        this.setupError = this.recordError(error);
        this.setupFailedAt = Date.now();
        throw error;
      })
      .finally(() => {
        this.configuring = undefined;
      });
    this.configuring = run;
    return run;
  }

  private version() {
    return this.env.VERSION.timestamp;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.owner && Date.now() - this.heartbeat > LEASE_MS)
        await this.stop(this.owner);
      // Each report is a billed request per lane; while nothing moves, report once a second.
      const quiet = this.snapshot().phase === "ready";
      if (quiet && Date.now() - this.reportedAt < 1000) return;
      this.reportedAt = Date.now();
      const lanes = await this.laneStubs();
      let broken = false;
      const reports = await Promise.all(
        lanes.map((lane, i) =>
          deadline(
            lane.report(this.version(), this.cursors[i] ?? 0),
            LANE_CALL_MS,
          ).catch(() => {
            broken = true;
            // Keep the last known totals; null would mean "not configured". The
            // cursor stays put, so the next reply resends any heights missed here.
            const last = this.reports[i];
            return last
              ? { ...last, blocks: [], blockCount: this.cursors[i] ?? 0 }
              : null;
          }),
        ),
      );
      // A stub that saw its object reset stays broken; the next tick makes new ones.
      if (broken) this.lanes = undefined;
      // A lane that restarted (deploy or eviction) reports null until configured again.
      // A failed setup (faucet cooldown, platform error) retries on its own.
      const retry =
        this.setupError !== undefined &&
        Date.now() - this.setupFailedAt > SETUP_RETRY_MS;
      if (
        (reports.some((r) => r === null) || retry) &&
        !this.configuring &&
        !this.owner
      )
        void this.configureLanes(this.settings).catch(() => {});
      this.reports = reports;
      reports.forEach((report, i) => this.addBlocks(i, report));
      // Keep only recent heights; the block rate looks at the last few.
      if (this.seen.size > 32)
        for (const height of [...this.seen.keys()].slice(
          0,
          this.seen.size - 32,
        )) {
          this.seen.delete(height);
        }
      this.readChainTimes();
      const state = this.snapshot();
      this.broadcast({ type: "state", state });
      this.stopIfIdle(state);
    } catch (error) {
      this.recordError(error);
    } finally {
      this.ticking = false;
    }
  }

  private stopIfIdle(state: Snapshot): void {
    const busy =
      this.ctx.getWebSockets().length > 0 ||
      state.owner !== null ||
      state.pending > 0 ||
      state.phase === "funding" ||
      state.phase === "draining";
    if (busy) this.lastActive = Date.now();
    else if (Date.now() - this.lastActive > IDLE_MS) {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Reads the chain tip every 250 ms and notes when each block commits. The index
   * stores blocks ~10 s late under load, so `getBlockByHeight` cannot time the
   * newest ones; the tip comes from the state database and does not lag.
   */
  private readChainTimes(): void {
    if (Date.now() - this.tipReadAt > TIP_READ_MS) {
      this.tipReadAt = Date.now();
      void fetch(String(this.env.THRUPUT_RPC_URL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getChainTip",
          params: {},
        }),
        signal: AbortSignal.timeout(LANE_CALL_MS),
      })
        .then((r) => r.json() as Promise<{ result?: { blockHeight: string } }>)
        .then((body) => {
          if (!body.result) return;
          const height = BigInt(body.result.blockHeight);
          if (height > this.tip) {
            this.tip = height;
            this.tipSeenAt.set(String(height), Date.now());
            if (this.tipSeenAt.size > 64)
              this.tipSeenAt.delete(this.tipSeenAt.keys().next().value!);
          }
        })
        .catch(() => {});
    }
  }

  private pendingNow(): number {
    return this.reports.reduce((n, r) => n + (r?.snapshot.pending ?? 0), 0);
  }

  /** The oldest recent send among all lanes' waiting transfers; 0 when none. */
  private oldestPendingAt(): number {
    let oldest = 0;
    for (const report of this.reports) {
      const at = report?.snapshot.oldestPendingAt ?? 0;
      if (at && (!oldest || at < oldest)) oldest = at;
    }
    return oldest;
  }

  /**
   * The newest block whose receipts are all in. While transfers are pending, the
   * newest block that this object saw commit before the oldest waiting transfer was
   * sent: no waiting transfer can be in it. (Taking the block before the newest
   * reported one failed under load: a few receipts from later blocks arrive while a
   * large block's are still coming in, and the headline fell to a few hundred.)
   * With nothing pending every receipt is in, so the block before the chain tip,
   * whose end the tip's start time gives: blocks after our last one hold none of our
   * transfers.
   */
  private frontier(pending: number): bigint | undefined {
    let newest: bigint | undefined;
    for (const height of this.seen.keys())
      if (newest === undefined || BigInt(height) > newest)
        newest = BigInt(height);
    if (pending > 0) {
      const waiting = this.oldestPendingAt();
      if (!waiting) return newest === undefined ? undefined : newest - 1n;
      let complete: bigint | undefined;
      for (const [height, seenAt] of this.tipSeenAt)
        if (
          seenAt < waiting &&
          (complete === undefined || BigInt(height) > complete)
        )
          complete = BigInt(height);
      return complete;
    }
    if (newest === undefined) return this.tip ? this.tip - 1n : undefined;
    return this.tip > newest ? this.tip - 1n : newest;
  }

  /** Merge a lane's newly reported heights and advance its cursor. */
  private addBlocks(lane: number, report: LaneReport | null): void {
    if (!report) return;
    for (const height of report.blocks) {
      this.blocks.add(height);
      if (!this.seen.has(height)) this.seen.set(height, Date.now());
    }
    this.cursors[lane] = report.blockCount;
  }

  /**
   * A lane submitted a batch. Batches arrive about 350 times a second at Futurenet's
   * limit, and each broadcast goes to every browser on this one thread, so batches
   * merge into one burst per PARTICLE_FLUSH_MS, drawn where the pointer is then.
   * Browsers draw each burst along the path from the previous one, so the trail still
   * follows a drag.
   */
  particles(count: number): void {
    this.particleCount += count;
    this.particleTimer ??= setTimeout(
      () => this.flushParticles(),
      PARTICLE_FLUSH_MS,
    );
  }

  private flushParticles(): void {
    this.particleTimer = undefined;
    const count = this.particleCount;
    this.particleCount = 0;
    this.sequence += count;
    this.broadcast({
      type: "particles",
      count,
      point: { ...this.point },
      sequence: this.sequence,
    });
  }

  /**
   * Confirmed transfers per second over the last RATE_WINDOW_MS: our successful
   * transfers in complete blocks that committed in that window, divided by the time
   * the chain took to commit them (from the commit of the block before the oldest
   * one), and never by less than the window. Commit times are when this object saw
   * each block become the chain tip, so one clock times both ends; a tip read of
   * margin is added. Blocks whose receipts are still arriving are not counted.
   *
   * Our transfers reach the chain in a cycle: loaded blocks of 100k-230k (55k-65k
   * tx/s each) while the in-flight cap fills, then nearly empty blocks while it
   * waits for receipts. The two-block rate this replaces reported the loaded pairs,
   * up to 73k tx/s while the spray sustained ~45k; the window spans a whole cycle.
   */
  private blockRate(counts: Map<string, number>, pending: number): number {
    const frontier = this.frontier(pending);
    if (frontier === undefined) return 0;
    // Nothing reported for a while although transfers are pending: none confirm now.
    // While blocks still commit, the index may only be late (~10 s under load).
    const quiet = Date.now() - Math.max(0, ...this.seen.values());
    const committing =
      Date.now() - Math.max(0, ...this.tipSeenAt.values()) < STALL_MS;
    if (
      pending > 0 &&
      quiet > STALL_MS &&
      (!committing || quiet > INDEX_LAG_MS)
    )
      return 0;
    const end = this.tipSeenAt.get(String(frontier));
    // Until this object has seen the frontier commit, keep the last value.
    if (end === undefined) return this.lastRate;
    let confirmed = 0;
    let start = end;
    for (const [height, committedAt] of this.tipSeenAt) {
      if (BigInt(height) > frontier || committedAt <= end - RATE_WINDOW_MS)
        continue;
      confirmed += counts.get(height) ?? 0;
      // The oldest counted block's work began when the block before it committed.
      const before = this.committedBefore(BigInt(height));
      if (before !== undefined && before < start) start = before;
    }
    const span = Math.max(end - start, RATE_WINDOW_MS) + TIP_READ_MS;
    this.lastRate = (confirmed * 1000) / span;
    return this.lastRate;
  }

  /** When the newest block below `height` was seen to commit; earlier if one was missed. */
  private committedBefore(height: bigint): number | undefined {
    let found: { height: bigint; at: number } | undefined;
    for (const [h, at] of this.tipSeenAt) {
      const value = BigInt(h);
      if (value < height && (found === undefined || value > found.height))
        found = { height: value, at };
    }
    return found?.at;
  }

  snapshot(): Snapshot {
    const reports = this.reports.filter((r): r is LaneReport => r !== null);
    const lanes = reports.map((r) => r.snapshot);
    const sum = (pick: (s: Snapshot) => number) =>
      lanes.reduce((n, s) => n + pick(s), 0);
    const succeeded = sum((s) => s.succeeded);
    const elapsedMs = Math.max(0, ...lanes.map((s) => s.elapsedMs));
    const receiptCount = reports.reduce((n, r) => n + r.receiptCount, 0);
    const receiptTimeMs = reports.reduce((n, r) => n + r.receiptTimeMs, 0);
    const recentConfirmed = sum((s) => s.liveTps);
    const byHeight = new Map<string, number>();
    for (const lane of lanes)
      for (const block of lane.recentBlocks)
        byHeight.set(
          block.height,
          (byHeight.get(block.height) ?? 0) + block.succeeded,
        );
    const errors = [...this.errors, ...lanes.flatMap((s) => s.errors)].filter(
      (e, i, all) => all.indexOf(e) === i,
    );
    let phase: Snapshot["phase"];
    let message: string;
    const laneError = lanes.find((s) => s.phase === "error");
    const pending = sum((s) => s.pending);
    const liveTps = this.blockRate(byHeight, pending);
    this.peakRate = Math.max(this.peakRate, liveTps);
    const pendingLimit = sum((s) => s.pendingLimit);
    if (this.setupError || laneError) {
      phase = "error";
      message = this.setupError ?? laneError!.message;
    } else if (lanes.length < this.laneCount || this.configuring) {
      const funding = lanes.find(
        (s) => s.phase === "funding" || s.phase === "connecting",
      );
      phase = funding?.phase ?? "connecting";
      message = funding?.message ?? "Connecting to Thruput";
    } else if (this.owner) {
      phase = "spraying";
      message = "Spraying real ERC20 transfers";
    } else if (pending || lanes.some((s) => s.phase !== "ready")) {
      phase = "draining";
      message = "Waiting for transaction receipts";
    } else {
      phase = "ready";
      message = "Ready to spray";
    }
    return {
      phase,
      message,
      settings: this.settings,
      walletCount: this.wallets,
      owner: this.owner,
      attempted: sum((s) => s.attempted),
      accepted: sum((s) => s.accepted),
      succeeded,
      failed: sum((s) => s.failed),
      unresolved: sum((s) => s.unresolved),
      resubmitted: sum((s) => s.resubmitted),
      assumed: sum((s) => s.assumed ?? 0),
      pending,
      liveTps,
      // No rate may read above what the chain did. Sends lead confirmations by up
      // to the in-flight cap, and a refill after a block of receipts can put more
      // than the chain's rate into one 10 s window, so cap at the best confirmed
      // rate shown; before the first one, the cap itself spread over 10 s.
      submitTps: Math.min(
        sum((s) => s.submitTps),
        this.peakRate || (pendingLimit * 1000) / RATE_WINDOW_MS,
      ),
      recentBlocks: [...byHeight]
        .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .slice(-16)
        .map(([height, count]) => ({ height, succeeded: count })),
      averageTps: elapsedMs ? (succeeded * 1000) / elapsedMs : 0,
      averageTxPerBlock: this.blocks.size ? succeeded / this.blocks.size : 0,
      observedBlocks: this.blocks.size,
      pendingLimit,
      averageReceiptMs: receiptCount ? receiptTimeMs / receiptCount : 0,
      // Each lane's 5 s average, weighted by the transfers it confirmed in that window.
      recentReceiptMs: recentConfirmed
        ? sum((s) => s.recentReceiptMs * s.liveTps) / recentConfirmed
        : 0,
      elapsedMs,
      backpressure: lanes.some((s) => s.backpressure),
      errors: errors.slice(-8),
      network:
        lanes[0]?.network ??
        (this.env.THRUPUT_NETWORK === "futurenet" ? "Futurenet" : "Localnet"),
      addresses: lanes[0]?.addresses ?? [],
    };
  }

  private async spray(id: string, point: Point): Promise<void> {
    const state = this.snapshot();
    if (!["ready", "spraying", "draining"].includes(state.phase))
      throw new Error(state.message);
    if (this.owner && this.owner !== id)
      throw new Error(
        "Another browser is spraying. Try again when it finishes.",
      );
    const starting = this.owner === null;
    if (starting) {
      this.sprayStartedAt = Date.now();
      this.lastRate = 0;
    }
    this.owner = id;
    this.point = point;
    this.heartbeat = Date.now();
    if (!starting && Date.now() - this.forwardedAt < FORWARD_MS) return;
    this.forwardedAt = Date.now();
    // Do not await the lanes: WebSocket messages from one browser are handled in
    // order, so a slow lane would hold back that browser's heartbeats and expire its
    // lease. Each lane holds its own lease for 1.5 s and hears from us every 250 ms.
    void this.laneStubs().then((lanes) =>
      Promise.allSettled(
        lanes.map((lane) =>
          deadline(
            lane.spray(this.version(), point, this.sprayStartedAt),
            LANE_CALL_MS,
          ),
        ),
      ).then((results) => {
        for (const result of results)
          if (result.status === "rejected") this.recordError(result.reason);
      }),
    );
  }

  private async stop(id: string): Promise<void> {
    if (this.owner !== id) return;
    this.owner = null;
    const session = this.sprayStartedAt;
    const lanes = await this.laneStubs();
    // Lanes stop on their own when heartbeats end; this only makes it immediate.
    await Promise.all(
      lanes.map((lane) =>
        deadline(lane.stop(session), LANE_CALL_MS).catch(() => {}),
      ),
    );
  }

  private async reset(): Promise<void> {
    const state = this.snapshot();
    if (state.phase !== "ready")
      throw new Error("Wait for all pending transfers before resetting");
    const lanes = await this.laneStubs();
    await Promise.all(
      lanes.map((lane) => deadline(lane.reset(), LANE_CALL_MS)),
    );
    this.blocks.clear();
    this.seen.clear();
    this.lastRate = 0;
    this.peakRate = 0;
    this.errors = [];
    this.cursors = [];
    // Report now: an empty report list would read as "connecting" until the next tick.
    this.reports = await Promise.all(
      lanes.map((lane) =>
        deadline(lane.report(this.version(), 0), LANE_CALL_MS).catch(
          () => null,
        ),
      ),
    );
    this.reports.forEach((report, i) => this.addBlocks(i, report));
  }

  private recordError(error: unknown): string {
    const message = publicErrorMessage(error);
    // Lanes reset themselves after a deploy; the next tick configures them again.
    if (message === "Worker version changed") return message;
    if (this.errors.at(-1) !== message)
      this.errors = [...this.errors.slice(-7), message];
    return message;
  }

  override async fetch(request: Request): Promise<Response> {
    if (isNewerVersion(request.headers.get(VERSION_HEADER), this.version())) {
      for (const ws of this.ctx.getWebSockets())
        ws.close(1012, "Service restart");
      this.ctx.abort("Worker version changed");
    }
    this.start();
    this.lastActive = Date.now();
    if (new URL(request.url).pathname === "/live") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server!, [crypto.randomUUID()]);
      this.send(server!, { type: "hello", id: this.idOf(server!) });
      this.send(server!, { type: "state", state: this.snapshot() });
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json(
      {
        ...this.snapshot(),
        exportedAt: new Date().toISOString(),
        lanes: await this.hosts(),
        coordinator: await this.probe().catch(() => null),
        // Deploys are done when every object runs this version; see scripts/deploy.sh.
        build: {
          version: this.env.VERSION.id,
          lanes: this.laneCount,
          lanesOnVersion: this.reports.filter(
            (r) => r?.version === this.env.VERSION.id,
          ).length,
        },
        measurement:
          "Successful committed receipts observed by this experiment's lanes; experiment throughput, not global network TPS",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  private host?: Promise<Host>;
  /** Where this object runs; Placement uses it to choose the coordinator. */
  probe(): Promise<Host> {
    return (this.host ??= measureHost(this.env.THRUPUT_RPC_URL).catch(
      (error: unknown) => {
        this.host = undefined;
        throw error;
      },
    ));
  }

  private async hosts() {
    const lanes = await this.laneStubs().catch(() => []);
    return Promise.all(lanes.map((lane) => lane.probe().catch(() => null)));
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    this.start();
    const id = this.idOf(ws);
    try {
      if (typeof raw !== "string" || raw.length > 4096)
        throw new Error("Invalid message");
      const command = commandSchema.parse(JSON.parse(raw));
      switch (command.type) {
        case "spray":
          await this.spray(id, command.point);
          break;
        case "stop":
          await this.stop(id);
          break;
        case "configure":
          if (this.owner || this.snapshot().phase !== "ready")
            throw new Error(
              "Wait for the current spray to drain before changing settings",
            );
          await this.configureLanes(command.settings);
          break;
        case "reset":
          await this.reset();
          break;
      }
      this.send(ws, { type: "state", state: this.snapshot() });
    } catch (error) {
      this.send(ws, { type: "error", message: publicErrorMessage(error) });
    }
  }

  override async webSocketClose(ws: WebSocket) {
    await this.stop(this.idOf(ws));
  }

  override async webSocketError(ws: WebSocket) {
    await this.stop(this.idOf(ws));
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
