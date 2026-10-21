import type { Point } from "../shared/protocol.js";

const capacity = 24_000;
// Submitted batches arrive in pulses: devnet confirms in blocks every ~2.5 s, and new
// batches go out as each block frees in-flight capacity. Particles are released at
// the smoothed arrival rate instead, so a drag shows a continuous stream.
const RATE_SECONDS = 2.5;
// Release faster when needed so no more than this much is ever waiting.
const MAX_LAG_SECONDS = 1.2;
// Particles live 1.2-3.6 s (2.4 s on average). Above this rate the pool would recycle
// live particles, which pop out early; draw fewer particles per transfer instead.
const POOL_RATE = (capacity / 2.4) * 0.8;
// Frame budget for building and filling particle paths; slower devices draw fewer.
const DRAW_BUDGET_MS = 8;
const palette = [
  "#d6fa7c",
  "#87e6a4",
  "#5dd6cd",
  "#75b5ed",
  "#b195f7",
  "#ef8bc7",
  "#fa9b78",
  "#f8d37a",
];

/**
 * Fixed storage. Each submitted transaction is represented once in `emitted`; at most
 * one particle is drawn for it, fewer when the rate or the frame budget requires.
 */
export class ParticleCanvas {
  private context: CanvasRenderingContext2D;
  private data = new Float32Array(capacity * 8);
  private cursor = 0;
  private width = 0;
  private height = 0;
  private lastTime = 0;
  private frame = 0;
  private previous: Point | null = null;
  private lastEmission = 0;
  reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  emitted = 0;
  private queued = 0;
  private arrived = 0;
  private rate = 0;
  private carry = 0;
  private aim: Point = { x: 0.5, y: 0.5 };
  private sequence = 0;
  /** Particles drawn per transfer, lowered while frames run over budget. */
  private frameDensity = 1;
  private drawCarry = 0;
  private drawMs = 0;
  private frames = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Your browser could not create a 2D canvas");
    this.context = context;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.frame = requestAnimationFrame((time) => this.draw(time));
  }

  /** Queue a submitted batch; draw() releases it as a steady stream at `aim`. */
  enqueue(count: number, point: Point, sequence: number): void {
    this.queued += count;
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
      return;
    }
    const perSecond = Math.max(this.rate, this.queued / MAX_LAG_SECONDS);
    const exact = perSecond * seconds + this.carry;
    const count = Math.min(this.queued, Math.floor(exact));
    this.carry = count < this.queued ? exact - count : 0;
    if (count === 0) return;
    this.queued -= count;
    const density = Math.min(
      this.frameDensity,
      POOL_RATE / Math.max(this.rate, 1),
    );
    const drawn = count * density + this.drawCarry;
    this.drawCarry = drawn - Math.floor(drawn);
    this.emit(Math.floor(drawn), count, this.aim, this.sequence);
  }

  private emit(
    count: number,
    transfers: number,
    point: Point,
    sequence: number,
  ): void {
    const now = performance.now();
    const previous =
      this.previous && now - this.lastEmission < 200 ? this.previous : point;
    for (let i = 0; i < count; i++) {
      const offset = (this.cursor++ % capacity) * 8;
      const t = Math.random();
      const angle = Math.random() * Math.PI * 2;
      const velocity = 45 + Math.random() ** 1.5 * 340;
      this.data[offset] =
        (previous.x + (point.x - previous.x) * t) * this.width;
      this.data[offset + 1] =
        (previous.y + (point.y - previous.y) * t) * this.height;
      this.data[offset + 2] = Math.cos(angle) * velocity;
      this.data[offset + 3] = Math.sin(angle) * velocity;
      this.data[offset + 4] = 1.2 + Math.random() * 2.4;
      this.data[offset + 5] = this.data[offset + 4]!;
      this.data[offset + 6] =
        Math.floor(sequence / 160 + Math.random() * 2) % palette.length;
      this.data[offset + 7] = 0.7 + Math.random() ** 3 * 2.2;
    }
    this.previous = point;
    this.lastEmission = now;
    this.emitted += transfers;
    this.canvas.dataset.emitted = String(this.emitted);
  }

  clear(): void {
    this.data.fill(0);
    this.context.clearRect(0, 0, this.width, this.height);
    this.previous = null;
    this.queued = 0;
    this.carry = 0;
  }

  private resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const ratio = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private draw(time: number): void {
    const elapsed = (time - (this.lastTime || time)) / 1000;
    const dt = Math.min(elapsed, 0.04);
    this.lastTime = time;
    // Release on real time (capped after a background tab) so the queue keeps pace.
    this.release(Math.min(elapsed, 0.25));
    const started = performance.now();
    const c = this.context;
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = "lighter";
    // One pass over the pool, one path per color.
    const paths = palette.map(() => new Path2D());
    const decay = Math.exp(-dt * 0.8);
    for (let i = 0; i < capacity; i++) {
      const o = i * 8;
      if (this.data[o + 4]! <= 0) continue;
      this.data[o + 4] = this.data[o + 4]! - dt;
      if (!this.reducedMotion) {
        const vx = this.data[o + 2]!;
        const vy = this.data[o + 3]!;
        this.data[o] = this.data[o]! + vx * dt;
        this.data[o + 1] = this.data[o + 1]! + vy * dt;
        this.data[o + 2] = vx * decay;
        this.data[o + 3] = vy * decay;
      }
      const life = Math.max(0, this.data[o + 4]! / this.data[o + 5]!);
      const radius = this.data[o + 7]! * Math.sqrt(life);
      const x = this.data[o]!;
      const y = this.data[o + 1]!;
      const path = paths[this.data[o + 6]!]!;
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, Math.PI * 2);
    }
    for (let color = 0; color < palette.length; color++) {
      c.fillStyle = palette[color]!;
      c.fill(paths[color]!);
    }
    // Keep drawing within budget: shed particles quickly, recover slowly.
    const cost = performance.now() - started;
    this.drawMs += (cost - this.drawMs) * 0.05;
    if (++this.frames % 30 === 0) {
      // Diagnostics for tests and devtools: smoothed draw cost and density.
      this.canvas.dataset.drawMs = this.drawMs.toFixed(1);
      this.canvas.dataset.density = Math.min(
        this.frameDensity,
        POOL_RATE / Math.max(this.rate, 1),
      ).toFixed(2);
    }
    if (cost > DRAW_BUDGET_MS)
      this.frameDensity = Math.max(0.1, this.frameDensity * 0.9);
    else if (cost < DRAW_BUDGET_MS / 2)
      this.frameDensity = Math.min(1, this.frameDensity * 1.02);
    c.globalCompositeOperation = "source-over";
    this.frame = requestAnimationFrame((next) => this.draw(next));
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
  }
}
