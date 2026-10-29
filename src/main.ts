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
function showScale(): void {
  element("ratio-caption").textContent =
    `1 DOT = ${particles.transfersPerParticle} TRANSFERS`;
}
showScale();
window.addEventListener("resize", showScale);
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
/** True once this spray has a confirmed rate; until then the headline shows sends. */
let confirmedThisSpray = false;
/** The headline's averaging time, as in the coordinator. */
const RATE_WINDOW_MS = 10_000;
/** When this browser first saw the current spray, and the attempts counted then. */
let sprayStart: { time: number; attempted: number } | null = null;
/** The HUD graph: confirmed and sent rates for the last 60 seconds. */
const GRAPH_MS = 60_000;
const rates: { time: number; confirmed: number; sent: number }[] = [];
/** Attempts seen in the last 10 s, for the send rate shown while spraying. */
const sends: { time: number; attempted: number }[] = [];

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
  particles.held = false;
  particles.local = false;
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
    // There is no queue: the next press after the release wins.
    notify("Another browser is spraying. Try again when it finishes.");
    return;
  }
  held = true;
  particles.held = true;
  particles.local = true;
  particles.aimAt(point);
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
  // A move with no button down means the release was missed (for example a lost
  // pointerup); stop rather than keep spraying.
  if (event.pointerType === "mouse" && event.buttons === 0) {
    stop();
    return;
  }
  updatePoint(event);
  particles.aimAt(point);
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
/** Shown instead of the headline number while it has no value yet. */
let headlinePlaceholder = "";
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
    const text =
      id === "live-tps" && headlinePlaceholder
        ? headlinePlaceholder
        : format.format(value.shown);
    const node = element(id);
    if (node.textContent !== text) node.textContent = text;
  }
  drawGraph();
  requestAnimationFrame(ease);
}
requestAnimationFrame(ease);

/** Confirmed rate as a filled line, sent rate as a dashed line; it scrolls each frame. */
function drawGraph(): void {
  const graph = element<HTMLCanvasElement>("rate-graph");
  const width = graph.clientWidth;
  const height = graph.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(devicePixelRatio, 2);
  if (graph.width !== Math.round(width * ratio)) {
    graph.width = Math.round(width * ratio);
    graph.height = Math.round(height * ratio);
  }
  const c = graph.getContext("2d");
  if (!c) return;
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.clearRect(0, 0, width, height);
  const now = Date.now();
  while (rates.length > 2 && rates[1]!.time < now - GRAPH_MS) rates.shift();
  const top = Math.max(
    1_000,
    ...rates.map((r) => Math.max(r.confirmed, r.sent)),
  );
  const x = (time: number) => ((time - (now - GRAPH_MS)) / GRAPH_MS) * width;
  const y = (value: number) => height - 1 - (value / top) * (height - 4);
  c.fillStyle = "rgb(255 255 255 / 8%)";
  c.fillRect(0, height - 1, width, 1);
  if (rates.length < 2) return;
  c.beginPath();
  rates.forEach((r, i) =>
    i
      ? c.lineTo(x(r.time), y(r.confirmed))
      : c.moveTo(x(r.time), y(r.confirmed)),
  );
  c.lineTo(x(now), y(rates.at(-1)!.confirmed));
  c.strokeStyle = "#d4f879";
  c.lineWidth = 1.5;
  c.stroke();
  c.lineTo(x(now), height);
  c.lineTo(x(rates[0]!.time), height);
  c.fillStyle = "rgb(212 248 121 / 14%)";
  c.fill();
  c.beginPath();
  rates.forEach((r, i) =>
    i ? c.lineTo(x(r.time), y(r.sent)) : c.moveTo(x(r.time), y(r.sent)),
  );
  c.lineTo(x(now), y(rates.at(-1)!.sent));
  c.setLineDash([2, 3]);
  c.strokeStyle = "#8b9280";
  c.lineWidth = 1;
  c.stroke();
  c.setLineDash([]);
}

let atCapacityUntil = 0;
function update(snapshot: Snapshot): void {
  state = snapshot;
  // Viewers smooth another browser's spray while it holds the canvas.
  particles.held = held || (state.owner !== null && state.owner !== clientId);
  const spraying = state.phase === "spraying";
  particles.confirmedRate = spraying ? state.liveTps : 0;
  const working = spraying || state.pending > 0;
  // Sends over the last 10 s / 10 s. At Futurenet's limit the in-flight cap fills
  // in ~2 s and then waits for receipts, so a shorter window reports a send rate
  // (100k/s and more) far above what the chain confirms.
  const now = Date.now();
  if (sends.length && state.attempted < sends.at(-1)!.attempted)
    sends.length = 0;
  sends.push({ time: now, attempted: state.attempted });
  while (sends.length > 2 && sends[1]!.time <= now - RATE_WINDOW_MS)
    sends.shift();
  const sendRate =
    ((state.attempted - sends[0]!.attempted) * 1000) / RATE_WINDOW_MS;
  const sendingNow = spraying ? sendRate : state.sendingTps;
  rates.push({
    time: now,
    confirmed: state.liveTps,
    sent: working ? sendingNow : 0,
  });
  app.classList.toggle("is-spraying", spraying);
  element("connection-dot").className =
    state.phase === "error" ? "error" : "ready";
  element("network-label").textContent = state.network;
  const status = element("status");
  status.dataset.phase = state.phase;
  // At Futurenet's limit the in-flight cap stays full while spraying; that is the
  // expected state, not a fault. Keep the line for a moment after the cap frees up,
  // so it does not flicker between blocks.
  if (state.backpressure && spraying) atCapacityUntil = Date.now() + 3_000;
  const watching = spraying && state.owner !== null && state.owner !== clientId;
  const message = watching
    ? "Another browser is spraying. You can spray when it ends."
    : spraying && Date.now() < atCapacityUntil
      ? "Futurenet is at capacity. New transfers go out as blocks confirm; none are dropped."
      : state.message;
  if (status.textContent !== message) status.textContent = message;
  // The first block takes 4-10 s to confirm completely at Futurenet's limit. Until
  // then the headline shows sends since the spray started, labelled as such,
  // instead of a zero that looks broken. Like the confirmed rate, it divides by at
  // least 10 s: the in-flight cap lets ~400k go out in the first 2 s, and then sends
  // wait for receipts, so a shorter time would report a rate the spray cannot keep.
  // After a release the spray's transfers keep confirming for several seconds.
  // Until the first of them is counted, show a dash rather than a 0 that reads as
  // "nothing confirmed".
  if (spraying) sprayStart ??= { time: Date.now(), attempted: state.attempted };
  if (working && state.liveTps > 0) confirmedThisSpray = true;
  if (!working) {
    confirmedThisSpray = false;
    sprayStart = null;
  }
  const sendingFirst = spraying && !confirmedThisSpray;
  const awaitingFirst = !spraying && working && !confirmedThisSpray;
  const sentRate = sprayStart
    ? ((state.attempted - sprayStart.attempted) * 1000) /
      Math.max(Date.now() - sprayStart.time, RATE_WINDOW_MS)
    : 0;
  const label = sendingFirst ? "SENDING TX / SEC" : "CONFIRMED TX / SEC";
  const note =
    sendingFirst || awaitingFirst
      ? "Waiting for the first block to confirm"
      : "Confirmed in the last 10 s";
  headlinePlaceholder = awaitingFirst ? "—" : "";
  if (element("rate-label").textContent !== label) {
    element("rate-label").textContent = label;
    // Sends and confirmations are different numbers; never glide from one to the
    // other, or a confirmed label shows the send rate on its way down.
    const headline = eased["live-tps"]!;
    headline.shown = sendingFirst ? sentRate : state.liveTps;
  }
  if (element("rate-note").textContent !== note)
    element("rate-note").textContent = note;
  const metrics: Record<string, number> = {
    "live-tps": sendingFirst ? sentRate : state.liveTps,
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
  // Batches go out in block-sized lumps, so the last second swings to 0 between
  // blocks. Show the 10 s rate while spraying and the last second after it.
  element("sending-tps").textContent = format.format(sendingNow);
  element("in-flight").textContent = format.format(state.pending);
  // Measured, not estimated: send-to-receipt time of the transfers that confirmed
  // in the last 5 s.
  element("confirm-delay").textContent =
    state.recentReceiptMs > 0
      ? ` · ${(state.recentReceiptMs / 1000).toFixed(1)} s to confirm`
      : "";
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
        // The spraying browser draws at its own pointer; others follow the server's.
        particles.enqueue(
          message.count,
          held ? point : message.point,
          message.sequence,
        );
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
