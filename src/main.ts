import "./style.css";
import {
  type Point,
  type ServerMessage,
  type Snapshot,
} from "../shared/protocol.js";
import { ParticleCanvas } from "./particles.js";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const canvas = element<HTMLCanvasElement>("canvas");
const particles = new ParticleCanvas(canvas);
const dialog = element<HTMLDialogElement>("controls");
const app = element("app");
const batchSize = element<HTMLInputElement>("batch-size");
const concurrency = element<HTMLInputElement>("concurrency");
const reducedMotion = element<HTMLInputElement>("reduced-motion");
const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
let socket: WebSocket;
let clientId = "";
let state: Snapshot | undefined;
let held = false;
let pointerId: number | null = null;
let point: Point = { x: 0.5, y: 0.5 };
let lastSent = 0;
let noticeTimer: ReturnType<typeof setTimeout>;
let dirty = false;
const history: number[] = [];

function send(message: unknown): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}
function notify(message: string): void {
  const notice = element(dialog.open ? "panel-notice" : "notice");
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 7000);
}
function stop(): void {
  if (held) send({ type: "stop" });
  held = false;
  if (pointerId !== null && canvas.hasPointerCapture(pointerId))
    canvas.releasePointerCapture(pointerId);
  pointerId = null;
}
function start(): void {
  if (
    socket.readyState !== WebSocket.OPEN ||
    !state ||
    !["ready", "spraying", "draining"].includes(state.phase)
  ) {
    notify(state?.message ?? "Waiting for the transaction engine.");
    return;
  }
  if (state.owner && state.owner !== clientId) {
    notify("Another browser is spraying. Your turn is next.");
    return;
  }
  held = true;
  send({ type: "spray", point });
  lastSent = performance.now();
}
function updatePoint(event: PointerEvent): void {
  point = {
    x: Math.max(0, Math.min(1, event.clientX / innerWidth)),
    y: Math.max(0, Math.min(1, event.clientY / innerHeight)),
  };
}
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || pointerId !== null) return;
  updatePoint(event);
  start();
  if (held) {
    pointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
  }
});
canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== pointerId) return;
  updatePoint(event);
  if (held && performance.now() - lastSent > 32) {
    send({ type: "spray", point });
    lastSent = performance.now();
  }
});
canvas.addEventListener("pointerup", stop);
canvas.addEventListener("pointercancel", stop);
canvas.addEventListener("lostpointercapture", stop);
window.addEventListener("blur", stop);
window.addEventListener("pagehide", stop);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
});
canvas.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat) {
      point = { x: 0.5, y: 0.5 };
      start();
    }
  }
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space") stop();
});
window.addEventListener("keydown", (event) => {
  if (event.code === "Escape") stop();
});
setInterval(() => {
  if (held) send({ type: "spray", point });
}, 250);

/**
 * The headline numbers glide toward each new value between the ten state updates a
 * second, so they read as live rather than stepping. A drop (a reset) snaps at once.
 */
const eased: Record<string, { shown: number; target: number }> = {
  "live-tps": { shown: 0, target: 0 },
  "total-confirmed": { shown: 0, target: 0 },
};
let easedAt = performance.now();
function ease(now: number): void {
  const step = 1 - Math.exp(-(now - easedAt) / 160);
  easedAt = now;
  for (const [id, value] of Object.entries(eased)) {
    const next =
      value.target < value.shown && id === "total-confirmed"
        ? value.target
        : value.shown + (value.target - value.shown) * step;
    // Settle exactly on the target once the remaining gap rounds away.
    value.shown = Math.abs(value.target - next) < 0.5 ? value.target : next;
    const text = format.format(value.shown);
    const node = element(id);
    if (node.textContent !== text) node.textContent = text;
  }
  requestAnimationFrame(ease);
}
requestAnimationFrame(ease);

function update(snapshot: Snapshot): void {
  state = snapshot;
  const spraying = state.phase === "spraying";
  app.classList.toggle("is-spraying", spraying);
  element("connection-dot").className =
    state.phase === "error" ? "error" : "ready";
  element("network-label").textContent = state.network;
  const status = element("status");
  status.dataset.phase = state.phase;
  const message = state.backpressure
    ? `Flow control: waiting for receipts (${format.format(state.pending)} pending). No transfers dropped.`
    : state.message;
  if (status.textContent !== message) status.textContent = message;
  const metrics: Record<string, number> = {
    "live-tps": state.liveTps,
    "total-confirmed": state.succeeded,
    "average-tps": state.averageTps,
    "submit-tps": state.submitTps,
    "average-tx-per-block": state.averageTxPerBlock,
    "observed-blocks": state.observedBlocks,
    "pending-limit": state.pendingLimit,
    succeeded: state.succeeded,
    pending: state.pending,
    failed: state.failed,
    unresolved: state.unresolved,
    attempted: state.attempted,
  };
  for (const [id, value] of Object.entries(metrics)) {
    if (id in eased) eased[id]!.target = value;
    else element(id).textContent = format.format(value);
  }
  element("sending-tps").textContent = format.format(state.sendingTps);
  element("in-flight").textContent = format.format(state.pending);
  const bars = element("block-bars").children;
  const blocks = state.recentBlocks;
  const tallest = Math.max(1, ...blocks.map((block) => block.succeeded));
  for (let i = 0; i < bars.length; i++) {
    // Oldest on the left, newest on the right; empty slots stay at the floor.
    const block = blocks[blocks.length - bars.length + i];
    const bar = bars[i] as HTMLElement;
    bar.style.height = `${block ? 4 + (20 * block.succeeded) / tallest : 4}px`;
    bar.title = block
      ? `Block ${block.height}: ${format.format(block.succeeded)} successful`
      : "";
  }
  element("receipt-delay").textContent =
    `${format.format(state.averageReceiptMs)} ms`;
  element("elapsed").textContent =
    `${(state.elapsedMs / 1000).toFixed(1)}s active`;
  element("wallet-caption").textContent = `${state.walletCount} WALLETS`;
  const configurable =
    (state.phase === "ready" || state.phase === "error") &&
    state.pending === 0 &&
    !state.owner;
  element<HTMLButtonElement>("apply").disabled = !configurable;
  element<HTMLButtonElement>("reset").disabled =
    state.phase !== "ready" || state.pending > 0;
  element("config-help").textContent =
    state.phase === "funding" || state.phase === "error"
      ? state.message
      : !configurable
        ? "Release the canvas and let pending transfers finish."
        : "Ready. Changes apply to the next spray.";
  if (!dirty) {
    batchSize.value = String(state.settings.batchSize);
    concurrency.value = String(state.settings.concurrency);
  }
  const errorList = element("error-list");
  if (errorList.dataset.errors !== state.errors.join("|")) {
    errorList.dataset.errors = state.errors.join("|");
    errorList.replaceChildren(
      ...state.errors.map((error) => {
        const li = document.createElement("li");
        li.textContent = error;
        return li;
      }),
    );
    element("errors").hidden = state.errors.length === 0;
  }
}
function connect(): void {
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`,
  );
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    switch (message.type) {
      case "hello":
        clientId = message.id;
        break;
      case "state":
        update(message.state);
        break;
      case "particles":
        app.classList.add("has-sprayed");
        particles.emit(message.count, message.point, message.sequence);
        break;
      case "error":
        stop();
        notify(message.message);
        break;
    }
  });
  socket.addEventListener("close", () => {
    held = false;
    stop();
    element("connection-dot").className = "error";
    element("network-label").textContent = "Reconnecting";
    element("status").dataset.phase = "error";
    element("status").textContent =
      "Connection lost. Spraying stopped. Reconnecting…";
    element<HTMLButtonElement>("apply").disabled = true;
    element<HTMLButtonElement>("reset").disabled = true;
    setTimeout(connect, 1500);
  });
}
element("open-controls").addEventListener("click", () => {
  stop();
  app.inert = true;
  dialog.showModal();
  element("open-controls").setAttribute("aria-expanded", "true");
});
function closeControls(): void {
  app.inert = false;
  dialog.close();
  element("open-controls").setAttribute("aria-expanded", "false");
  element("open-controls").focus();
}
element("close-controls").addEventListener("click", closeControls);
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeControls();
});
dialog.addEventListener("click", (event) => {
  if (
    event.target === dialog &&
    event.clientX < dialog.getBoundingClientRect().left
  )
    closeControls();
});
batchSize.addEventListener("input", () => {
  dirty = true;
});
concurrency.addEventListener("input", () => {
  dirty = true;
});
element("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  send({
    type: "configure",
    settings: {
      batchSize: Number(batchSize.value),
      concurrency: Number(concurrency.value),
    },
  });
  dirty = false;
});
element("reset").addEventListener("click", () => {
  send({ type: "reset" });
  history.length = 0;
  particles.clear();
  app.classList.remove("has-sprayed");
});
element("clear").addEventListener("click", () => particles.clear());
reducedMotion.checked = particles.reducedMotion;
reducedMotion.addEventListener("change", () => {
  particles.reducedMotion = reducedMotion.checked;
});

setInterval(() => {
  history.push(state?.liveTps ?? 0);
  if (history.length > 60) history.shift();
  if (!dialog.open) return;
  const chart = element<HTMLCanvasElement>("chart");
  const c = chart.getContext("2d");
  if (!c) return;
  const width = chart.clientWidth;
  chart.width = width * 2;
  chart.height = 160;
  c.scale(2, 2);
  c.strokeStyle = "#d4f879";
  c.lineWidth = 1.5;
  c.beginPath();
  const maximum = Math.max(100, ...history);
  for (let i = 0; i < history.length; i++) {
    const x = ((60 - history.length + i) / 59) * width;
    const y = 75 - (history[i]! / maximum) * 65;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.stroke();
}, 1000);
connect();
