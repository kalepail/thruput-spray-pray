import type { Point } from "../shared/protocol.js";
import {
  SLOT_FLOATS,
  createRenderer,
  palette,
  type ParticleRenderer,
} from "./particle-renderers.js";

const capacity = 30_000;
/**
 * One particle stands for this many transfers, so the spray grows and shrinks with
 * throughput. Devnet's limit (~45k tx/s) is then ~9,000 particles/s, inside the pool.
 */
export const TRANSFERS_PER_PARTICLE = 5;
// Submitted batches arrive in waves: at devnet's limit the in-flight cap fills, then
// waits for receipts, which come in blocks of 100,000 or more every ~3 s. A spray
// therefore submits in a ~10 s cycle while the confirmed rate stays level. Particles
// are released at the confirmed rate once one is known, so the spray matches the
// headline; before that, at the smoothed submission rate.
const RATE_SECONDS = 2.5;
// Release faster when needed so no more than this much is ever waiting; it spans one
// submission cycle. Release discards the queue, so this adds no trail after a click.
const MAX_LAG_SECONDS = 12;
// Release at the full rate only while this much is waiting, and slower below it, so a
// pause in submissions (devnet sometimes confirms nothing for ~5 s) thins the spray
// gradually instead of cutting it off.
const RESERVE_SECONDS = 4;
// Particles that arrive while nobody has held the canvas yet (a viewer joining
// mid-spray) flush at a fixed fast rate.
const FLUSH_SECONDS = 0.08;
const MIN_FLUSH_RATE = 40_000;
// Particles live 1.2-3.6 s (2.4 s on average). Above this rate the pool would recycle
// live particles, which pop out early; draw fewer particles per transfer instead.
const POOL_RATE = (capacity / 2.4) * 0.8;
// CPU budget per frame for drawing; slower devices draw fewer particles. WebGL stays
// far inside it; the Canvas 2D fallback does not on phones at devnet's limit.
const DRAW_BUDGET_MS = 8;
// Particle times are float32 seconds from this epoch; rebase it before precision drops.
const REBASE_SECONDS = 1_000;
// A batch reaches the canvas ~200 ms after a click: the round trip plus signing the
// first batch. While a browser holds, draw predicted particles at the recent rate
// whenever nothing real is waiting; real arrivals pay them back instead of being
// drawn twice. Prediction runs at most this far ahead and stops on release.
const PREDICT_AHEAD_SECONDS = 0.4;
// Rate to predict before any spray has been observed.
const FIRST_PREDICT_RATE = 4_000;
// After release, late arrivals may still pay back predictions for this long.
const PAYBACK_MS = 1_500;

/**
 * Fixed storage. Each submitted transaction is represented once in `emitted`; one
 * particle is drawn per TRANSFERS_PER_PARTICLE, fewer when the pool or the frame
 * budget requires.
 */
export class ParticleCanvas {
  private renderer: ParticleRenderer;
  private data = new Float32Array(capacity * SLOT_FLOATS);
  private cursor = 0;
  /** Slots written since the renderer last received them start here. */
  private uploaded = 0;
  private epoch = performance.now();
  private width = 0;
  private height = 0;
  private lastTime = 0;
  private frame = 0;
  private previous: Point | null = null;
  private lastEmission = 0;
  reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private holding = false;
  /** True while this browser sprays; only then are particles predicted. */
  local = false;
  /** Particles drawn ahead of real submissions, not yet paid back. */
  private predicted = 0;
  private predictCarry = 0;
  private heldRate = 0;
  private paybackUntil = 0;
  private releasedAt = 0;
  emitted = 0;
  private queued = 0;
  private arrived = 0;
  private rate = 0;
  /** Confirmed transfers per second for the current spray; 0 until known. */
  confirmedRate = 0;
  private releaseRate = 0;
  private carry = 0;
  private aim: Point = { x: 0.5, y: 0.5 };
  private sequence = 0;
  /** Share of the fixed ratio drawn, lowered while frames run over budget. */
  private frameShare = 1;
  private drawCarry = 0;
  private drawMs = 0;
  private drawn = 0;
  private frames = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    canvas.dataset.renderer = this.renderer.name;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.frame = requestAnimationFrame((time) => this.draw(time));
  }

  /** True while a browser holds the canvas; smoothing and prediction apply then. */
  get held(): boolean {
    return this.holding;
  }
  set held(value: boolean) {
    if (this.holding && !value) {
      if (this.rate > 0) this.heldRate = this.rate;
      this.releasedAt = performance.now();
      this.paybackUntil = this.releasedAt + PAYBACK_MS;
      // The spray ends where the click ends. Drawing the waiting queue here made a
      // large burst at the release point that read as the spray continuing; count it
      // without drawing, as for batches that arrive after release.
      this.represent(this.queued);
      this.queued = 0;
      this.carry = 0;
    }
    this.holding = value;
  }

  /** Queue a submitted batch; draw() releases it as a steady stream at `aim`. */
  enqueue(count: number, point: Point, sequence: number): void {
    // Transfers already shown as predictions are represented, not drawn again.
    const paid = Math.min(this.predicted, count);
    this.predicted -= paid;
    if (paid) this.represent(paid);
    // After a release, batches still arriving from that click are counted only.
    const late = !this.holding && this.releasedAt > 0;
    if (late) this.represent(count - paid);
    else this.queued += count - paid;
    this.arrived += count;
    this.aim = point;
    this.sequence = sequence;
  }

  /** Where new particles appear; the spraying browser follows its own pointer. */
  aimAt(point: Point): void {
    this.aim = point;
  }

  /** Releases queued particles for one frame of `seconds`. */
  private release(seconds: number): void {
    if (seconds <= 0) return;
    const smoothing = 1 - Math.exp(-seconds / RATE_SECONDS);
    this.rate += (this.arrived / seconds - this.rate) * smoothing;
    this.arrived = 0;
    if (this.queued <= 0) {
      this.carry = 0;
      this.predict(seconds);
      return;
    }
    const target = this.confirmedRate || this.rate;
    const perSecond = this.held
      ? Math.max(
          Math.min(target, this.queued / RESERVE_SECONDS),
          this.queued / MAX_LAG_SECONDS,
        )
      : Math.max(MIN_FLUSH_RATE, this.queued / FLUSH_SECONDS);
    this.releaseRate = perSecond;
    const exact = perSecond * seconds + this.carry;
    const count = Math.min(this.queued, Math.floor(exact));
    this.carry = count < this.queued ? exact - count : 0;
    if (count === 0) return;
    this.queued -= count;
    // Bound by the release rate: a burst must not recycle live particles.
    const density = this.density(perSecond);
    const drawn = count * density + this.drawCarry;
    this.drawCarry = drawn - Math.floor(drawn);
    this.emit(Math.floor(drawn), count, this.aim, this.sequence);
  }

  /** While held with nothing real waiting, draw ahead at the recent rate. */
  private predict(seconds: number): void {
    if (!this.holding || !this.local) {
      if (performance.now() > this.paybackUntil) this.predicted = 0;
      this.predictCarry = 0;
      return;
    }
    const rate = Math.max(this.rate, this.heldRate) || FIRST_PREDICT_RATE;
    const room = rate * PREDICT_AHEAD_SECONDS - this.predicted;
    const exact = Math.min(room, rate * seconds + this.predictCarry);
    if (exact < 1) return;
    const count = Math.floor(exact);
    this.predictCarry = exact - count;
    this.predicted += count;
    this.emit(
      Math.floor(count * this.density(rate)),
      0,
      this.aim,
      this.sequence,
    );
  }

  /** Particles per transfer: the fixed ratio, lowered for the pool and frame budget. */
  private density(transfersPerSecond: number): number {
    return Math.min(
      this.frameShare / TRANSFERS_PER_PARTICLE,
      POOL_RATE / Math.max(transfersPerSecond, 1),
    );
  }

  /** Count transfers as represented without drawing them. */
  private represent(transfers: number): void {
    this.emitted += transfers;
    this.canvas.dataset.emitted = String(this.emitted);
  }

  private emit(
    count: number,
    transfers: number,
    point: Point,
    sequence: number,
  ): void {
    const now = performance.now();
    const birth = (now - this.epoch) / 1000;
    const previous =
      this.previous && now - this.lastEmission < 200 ? this.previous : point;
    for (let i = 0; i < count; i++) {
      const offset = (this.cursor++ % capacity) * SLOT_FLOATS;
      const t = Math.random();
      const angle = Math.random() * Math.PI * 2;
      const velocity = 45 + Math.random() ** 1.5 * 340;
      this.data[offset] =
        (previous.x + (point.x - previous.x) * t) * this.width;
      this.data[offset + 1] =
        (previous.y + (point.y - previous.y) * t) * this.height;
      this.data[offset + 2] = Math.cos(angle) * velocity;
      this.data[offset + 3] = Math.sin(angle) * velocity;
      this.data[offset + 4] = birth;
      this.data[offset + 5] = 1.2 + Math.random() * 2.4;
      this.data[offset + 6] = 0.7 + Math.random() ** 3 * 2.2;
      this.data[offset + 7] =
        Math.floor(sequence / 160 + Math.random() * 2) % palette.length;
    }
    this.previous = point;
    this.lastEmission = now;
    this.represent(transfers);
    if (count) {
      this.drawn += count;
      this.canvas.dataset.drawn = String(this.drawn);
    }
  }

  clear(): void {
    this.data.fill(0);
    this.uploaded = this.cursor - capacity;
    this.previous = null;
    this.queued = 0;
    this.carry = 0;
    this.predicted = 0;
  }

  private resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const ratio = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.renderer.resize(this.width, this.height, ratio);
  }

  /** Hands the renderer every slot written since the last frame. */
  private upload(): void {
    const pending = Math.min(this.cursor - this.uploaded, capacity);
    if (pending <= 0) return;
    // After clear() or a rebase this reaches back a whole pool, before slot 0 on a
    // new page; wrap it into range.
    const from = (((this.cursor - pending) % capacity) + capacity) % capacity;
    const to = from + pending;
    this.renderer.upload(this.data, from, Math.min(to, capacity));
    if (to > capacity) this.renderer.upload(this.data, 0, to - capacity);
    this.uploaded = this.cursor;
  }

  private draw(time: number): void {
    const elapsed = (time - (this.lastTime || time)) / 1000;
    this.lastTime = time;
    // Release on real time (capped after a background tab) so the queue keeps pace.
    this.release(Math.min(elapsed, 0.25));
    const started = performance.now();
    let now = (started - this.epoch) / 1000;
    if (now > REBASE_SECONDS) {
      for (let o = 4; o < this.data.length; o += SLOT_FLOATS)
        this.data[o] = this.data[o]! - REBASE_SECONDS;
      this.epoch += REBASE_SECONDS * 1000;
      now -= REBASE_SECONDS;
      this.uploaded = this.cursor - capacity;
    }
    this.upload();
    this.renderer.draw(this.data, now, this.reducedMotion ? 0 : 1);
    // Keep drawing within budget: shed particles quickly, recover slowly.
    const cost = performance.now() - started;
    this.drawMs += (cost - this.drawMs) * 0.05;
    if (++this.frames % 30 === 0) {
      // Diagnostics for tests and devtools: smoothed draw cost and density.
      this.canvas.dataset.drawMs = this.drawMs.toFixed(1);
      this.canvas.dataset.density = this.density(this.releaseRate).toFixed(2);
    }
    if (cost > DRAW_BUDGET_MS)
      this.frameShare = Math.max(0.1, this.frameShare * 0.9);
    else if (cost < DRAW_BUDGET_MS / 2)
      this.frameShare = Math.min(1, this.frameShare * 1.02);
    this.frame = requestAnimationFrame((next) => this.draw(next));
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
  }
}
