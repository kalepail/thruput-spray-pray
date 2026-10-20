import type { Point } from "../shared/protocol.js";

const capacity = 24_000;
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

/** Fixed storage; one slot is emitted for each submitted transaction. */
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

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Your browser could not create a 2D canvas");
    this.context = context;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.frame = requestAnimationFrame((time) => this.draw(time));
  }

  emit(count: number, point: Point, sequence: number): void {
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
    this.emitted += count;
    this.canvas.dataset.emitted = String(this.emitted);
  }

  clear(): void {
    this.data.fill(0);
    this.context.clearRect(0, 0, this.width, this.height);
    this.previous = null;
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
    const dt = Math.min((time - (this.lastTime || time)) / 1000, 0.04);
    this.lastTime = time;
    const c = this.context;
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = "lighter";
    for (let color = 0; color < palette.length; color++) {
      c.fillStyle = palette[color]!;
      c.beginPath();
      for (let i = 0; i < capacity; i++) {
        const o = i * 8;
        if (this.data[o + 4]! <= 0 || this.data[o + 6] !== color) continue;
        this.data[o + 4] = this.data[o + 4]! - dt;
        if (!this.reducedMotion) {
          const vx = this.data[o + 2]!;
          const vy = this.data[o + 3]!;
          this.data[o] = this.data[o]! + vx * dt;
          this.data[o + 1] = this.data[o + 1]! + vy * dt;
          this.data[o + 2] = vx * Math.exp(-dt * 0.8);
          this.data[o + 3] = vy * Math.exp(-dt * 0.8);
        }
        const life = Math.max(0, this.data[o + 4]! / this.data[o + 5]!);
        const radius = this.data[o + 7]! * Math.sqrt(life);
        const x = this.data[o]!;
        const y = this.data[o + 1]!;
        c.moveTo(x + radius, y);
        c.arc(x, y, radius, 0, Math.PI * 2);
      }
      c.fill();
    }
    c.globalCompositeOperation = "source-over";
    this.frame = requestAnimationFrame((next) => this.draw(next));
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
  }
}
