import { DurableObject, env } from "cloudflare:workers";
import {
  defaults,
  WALLET_COUNT,
  type Point,
  type ServerMessage,
  type Settings,
  type Snapshot,
} from "../shared/protocol.js";
import { commandSchema, settingsSchema } from "../server/commands.js";
import { engineLimits } from "../server/engine.js";
import { publicErrorMessage } from "../server/errors.js";
import { isNewerVersion } from "./host.js";
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

type Lane = ReturnType<typeof laneStub>;

// A lane call that never settles would otherwise block the caller indefinitely.
const LANE_CALL_MS = 5_000;
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
  private laneCount = WALLET_COUNT;
  private outstanding = 0;
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
  private blocks = new Set<string>();
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
    this.outstanding = engineLimits(vars).outstanding;
    this.laneCount = Number(vars.SPRAY_LANES ?? WALLET_COUNT);
    if (
      !Number.isInteger(this.laneCount) ||
      this.laneCount < WALLET_COUNT ||
      this.laneCount % WALLET_COUNT
    )
      throw new Error(`SPRAY_LANES must be a multiple of ${WALLET_COUNT}`);
    this.lastActive = Date.now();
    this.timer = setInterval(() => void this.tick(), 100);
    void this.configureLanes(this.settings).catch(() => {});
  }

  private laneStubs(): Promise<Lane[]> {
    return (this.lanes ??= (env.PLACEMENT as DurableObjectNamespace<Placement>)
      .getByName("placement")
      .lanes(this.laneCount)
      .then((names) => names.map(laneStub))
      .catch((error: unknown) => {
        this.lanes = undefined;
        throw error;
      }));
  }

  /** Lane settings divide the total concurrency and in-flight budget between lanes. */
  private laneSettings(settings: Settings) {
    return {
      settings: {
        batchSize: settings.batchSize,
        concurrency: Math.max(
          1,
          Math.ceil(settings.concurrency / this.laneCount),
        ),
      },
      outstanding: Math.floor(this.outstanding / this.laneCount),
    };
  }

  private configureLanes(settings: Settings): Promise<void> {
    if (this.configuring)
      return Promise.reject(new Error("Configuration is already running"));
    const { settings: lane, outstanding } = this.laneSettings(settings);
    this.setupError = undefined;
    const run = (async () => {
      const lanes = await this.laneStubs();
      const results = await Promise.allSettled(
        lanes.map((stub, index) =>
          deadline(
            stub.configure(
              this.version(),
              {
                sender: index % WALLET_COUNT,
                slot: Math.floor(index / WALLET_COUNT),
                slots: this.laneCount / WALLET_COUNT,
              },
              lane,
              outstanding,
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
          deadline(lane.report(this.version()), LANE_CALL_MS).catch(() => {
            broken = true;
            // Keep the last known totals; null would mean "not configured".
            const last = this.reports[i];
            return last ? { ...last, particles: 0, newBlocks: [] } : null;
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
      let particles = 0;
      for (const report of reports) {
        if (!report) continue;
        particles += report.particles;
        for (const height of report.newBlocks) this.blocks.add(height);
      }
      if (particles) {
        this.sequence += particles;
        this.broadcast({
          type: "particles",
          count: particles,
          point: { ...this.point },
          sequence: this.sequence,
        });
      }
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

  snapshot(): Snapshot {
    const reports = this.reports.filter((r): r is LaneReport => r !== null);
    const lanes = reports.map((r) => r.snapshot);
    const sum = (pick: (s: Snapshot) => number) =>
      lanes.reduce((n, s) => n + pick(s), 0);
    const succeeded = sum((s) => s.succeeded);
    const elapsedMs = Math.max(0, ...lanes.map((s) => s.elapsedMs));
    const receiptCount = reports.reduce((n, r) => n + r.receiptCount, 0);
    const receiptTimeMs = reports.reduce((n, r) => n + r.receiptTimeMs, 0);
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
      walletCount: WALLET_COUNT,
      owner: this.owner,
      attempted: sum((s) => s.attempted),
      accepted: sum((s) => s.accepted),
      succeeded,
      failed: sum((s) => s.failed),
      unresolved: sum((s) => s.unresolved),
      resubmitted: sum((s) => s.resubmitted),
      pending,
      liveTps: sum((s) => s.liveTps),
      submitTps: sum((s) => s.submitTps),
      sendingTps: sum((s) => s.sendingTps),
      recentBlocks: [...byHeight]
        .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .slice(-5)
        .map(([height, count]) => ({ height, succeeded: count })),
      averageTps: elapsedMs ? (succeeded * 1000) / elapsedMs : 0,
      averageTxPerBlock: this.blocks.size ? succeeded / this.blocks.size : 0,
      observedBlocks: this.blocks.size,
      pendingLimit: sum((s) => s.pendingLimit),
      averageReceiptMs: receiptCount ? receiptTimeMs / receiptCount : 0,
      elapsedMs,
      backpressure: lanes.some((s) => s.backpressure),
      errors: errors.slice(-8),
      network: lanes[0]?.network ?? "Devnet",
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
          deadline(lane.spray(this.version(), point), LANE_CALL_MS),
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
    const lanes = await this.laneStubs();
    // Lanes stop on their own when heartbeats end; this only makes it immediate.
    await Promise.all(
      lanes.map((lane) => deadline(lane.stop(), LANE_CALL_MS).catch(() => {})),
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
    this.errors = [];
    // Report now: an empty report list would read as "connecting" until the next tick.
    this.reports = await Promise.all(
      lanes.map((lane) =>
        deadline(lane.report(this.version()), LANE_CALL_MS).catch(() => null),
      ),
    );
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
