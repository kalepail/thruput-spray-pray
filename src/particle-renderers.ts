/**
 * Particle pool layout, 8 floats per slot: x, y, vx, vy, birth (s), life (s; 0 is an
 * empty slot), radius (px), palette index. Both renderers draw from the same pool and
 * the same motion model, so they look alike.
 */
export const SLOT_FLOATS = 8;
/** Velocity decays as exp(-DRAG * age); position is its integral. */
export const DRAG = 0.8;
export const palette = [
  "#d6fa7c",
  "#87e6a4",
  "#5dd6cd",
  "#75b5ed",
  "#b195f7",
  "#ef8bc7",
  "#fa9b78",
  "#f8d37a",
];

export interface ParticleRenderer {
  readonly name: "webgl" | "2d";
  resize(width: number, height: number, ratio: number): void;
  /** Slots [from, to) changed since the last draw. */
  upload(data: Float32Array, from: number, to: number): void;
  /** `motion` is 0 for reduced motion: particles stay where they appear. */
  draw(data: Float32Array, now: number, motion: number): void;
}

/** WebGL when the device has a real GPU, else Canvas 2D; `?renderer=2d` forces 2D. */
export function createRenderer(canvas: HTMLCanvasElement): ParticleRenderer {
  if (new URLSearchParams(location.search).get("renderer") !== "2d") {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      failIfMajorPerformanceCaveat: true,
    });
    if (gl) return new GlRenderer(canvas, gl);
  }
  return new CanvasRenderer(canvas);
}

const VERTEX = `
attribute vec2 origin;
attribute vec2 velocity;
attribute float birth;
attribute float life;
attribute float radius;
attribute float color;
uniform float now;
uniform float motion;
uniform vec2 size;
uniform float ratio;
uniform vec3 palette[${palette.length}];
varying vec3 tint;
varying float diameter;
void main() {
  float age = now - birth;
  if (life == 0.0 || age < 0.0 || age >= life) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec2 p = origin + velocity * motion * (1.0 - exp(-${DRAG.toFixed(1)} * age)) / ${DRAG.toFixed(1)};
  diameter = max(2.0 * radius * sqrt(1.0 - age / life) * ratio, 1.0);
  gl_PointSize = diameter + 1.0;
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
  int index = int(color);
  tint = palette[0];
  for (int i = 1; i < ${palette.length}; i++) if (i == index) tint = palette[i];
}`;

const FRAGMENT = `
precision mediump float;
varying vec3 tint;
varying float diameter;
void main() {
  float d = length(gl_PointCoord - 0.5) * (diameter + 1.0);
  float a = clamp(diameter * 0.5 - d + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(tint * a, a);
}`;

/**
 * Positions come from each particle's spawn values and age on the GPU, so the CPU
 * only uploads new particles: its cost follows the spawn rate, not the live count.
 */
class GlRenderer implements ParticleRenderer {
  readonly name = "webgl";
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private size: [number, number, number] = [1, 1, 1];
  /** After a context restore the buffer is empty; upload the whole pool once. */
  private stale = true;

  constructor(
    private canvas: HTMLCanvasElement,
    private gl: WebGLRenderingContext,
  ) {
    canvas.addEventListener("webglcontextlost", (event) =>
      event.preventDefault(),
    );
    canvas.addEventListener("webglcontextrestored", () => this.setup());
    this.setup();
  }

  private setup(): void {
    const gl = this.gl;
    const program = gl.createProgram()!;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    const stride = SLOT_FLOATS * 4;
    for (const [name, floats, offset] of [
      ["origin", 2, 0],
      ["velocity", 2, 2],
      ["birth", 1, 4],
      ["life", 1, 5],
      ["radius", 1, 6],
      ["color", 1, 7],
    ] as const) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        floats,
        gl.FLOAT,
        false,
        stride,
        offset * 4,
      );
    }
    this.uniforms.clear();
    for (const name of ["now", "motion", "size", "ratio", "palette"])
      this.uniforms.set(name, gl.getUniformLocation(program, name));
    gl.uniform3fv(
      this.uniforms.get("palette")!,
      palette.flatMap((hex) =>
        [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255),
      ),
    );
    // Additive, like the 2D renderer's "lighter".
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
    this.stale = true;
    this.resize(...this.size);
  }

  resize(width: number, height: number, ratio: number): void {
    this.size = [width, height, ratio];
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.uniforms.get("size")!, width, height);
    gl.uniform1f(this.uniforms.get("ratio")!, ratio);
  }

  upload(data: Float32Array, from: number, to: number): void {
    if (this.stale || this.gl.isContextLost()) return;
    this.gl.bufferSubData(
      this.gl.ARRAY_BUFFER,
      from * SLOT_FLOATS * 4,
      data.subarray(from * SLOT_FLOATS, to * SLOT_FLOATS),
    );
  }

  draw(data: Float32Array, now: number, motion: number): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this.stale) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.stale = false;
    }
    gl.uniform1f(this.uniforms.get("now")!, now);
    gl.uniform1f(this.uniforms.get("motion")!, motion);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, data.length / SLOT_FLOATS);
  }
}

/** Fallback: one pass over the pool, one path per color. */
class CanvasRenderer implements ParticleRenderer {
  readonly name = "2d";
  private context: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Your browser could not create a 2D canvas");
    this.context = context;
  }

  resize(width: number, height: number, ratio: number): void {
    this.width = width;
    this.height = height;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  upload(): void {}

  draw(data: Float32Array, now: number, motion: number): void {
    const c = this.context;
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = "lighter";
    const paths = palette.map(() => new Path2D());
    for (let o = 0; o < data.length; o += SLOT_FLOATS) {
      const life = data[o + 5]!;
      const age = now - data[o + 4]!;
      if (life === 0 || age < 0 || age >= life) continue;
      const travel = (motion * (1 - Math.exp(-DRAG * age))) / DRAG;
      const x = data[o]! + data[o + 2]! * travel;
      const y = data[o + 1]! + data[o + 3]! * travel;
      const radius = data[o + 6]! * Math.sqrt(1 - age / life);
      const path = paths[data[o + 7]!]!;
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, Math.PI * 2);
    }
    for (let color = 0; color < palette.length; color++) {
      c.fillStyle = palette[color]!;
      c.fill(paths[color]!);
    }
    c.globalCompositeOperation = "source-over";
  }
}
