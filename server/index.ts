import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { defaults, type ServerMessage } from "../shared/protocol.js";
import { commandSchema, settingsSchema } from "./commands.js";
import { thruputChain } from "./chain.js";
import { Engine, engineLimits } from "./engine.js";
import { networkConfig } from "./network.js";
import { publicErrorMessage } from "./errors.js";

const port = Number(process.env.PORT ?? 5177);
const host = process.env.HOST ?? "127.0.0.1";
const network = networkConfig();
const { rpcUrl } = network;
const production = import.meta.url.includes("/dist/");
const startingSettings = settingsSchema.parse({
  batchSize: Number(process.env.SPRAY_BATCH_SIZE ?? defaults.batchSize),
  concurrency: Number(process.env.SPRAY_CONCURRENCY ?? defaults.concurrency),
});
const engine = new Engine(
  thruputChain(network, {
    prepareWorkers: Number(process.env.SPRAY_PREPARE_WORKERS ?? 0),
  }),
  engineLimits(process.env),
);
const vite = production
  ? undefined
  : await (
      await import("vite")
    ).createServer({ server: { middlewareMode: true }, appType: "spa" });
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const server = createServer(async (req, res) => {
  if (req.url === "/api/state" || req.url === "/api/export") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        ...engine.snapshot(),
        exportedAt: new Date().toISOString(),
        measurement:
          "Successful committed receipts observed by this Node process; experiment throughput, not global network TPS",
      }),
    );
    return;
  }
  if (vite) {
    vite.middlewares(req, res);
    return;
  }
  try {
    const pathname = decodeURIComponent(
      new URL(req.url ?? "/", "http://localhost").pathname,
    );
    const root = resolve("dist/web");
    const file = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!file.startsWith(`${root}/`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.setHeader(
      "Content-Type",
      mime[extname(file)] ?? "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/live") return; // Vite owns its HMR upgrades.
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 1_000_000) {
    ws.close(1013, "Client cannot keep up");
    return;
  }
  ws.send(JSON.stringify(message));
}
function broadcast(message: ServerMessage): void {
  for (const ws of wss.clients) send(ws, message);
}
engine.on("state", (state) => broadcast({ type: "state", state }));
engine.on("particles", (event) => broadcast({ type: "particles", ...event }));
wss.on("connection", (ws) => {
  const id = randomUUID();
  send(ws, { type: "hello", id });
  send(ws, { type: "state", state: engine.snapshot() });
  ws.on("error", () => engine.stop(id));
  ws.on("close", () => engine.stop(id));
  ws.on("message", (raw) => {
    void (async () => {
      try {
        const command = commandSchema.parse(JSON.parse(raw.toString()));
        switch (command.type) {
          case "spray":
            engine.spray(id, command.point);
            break;
          case "stop":
            engine.stop(id);
            break;
          case "configure":
            await engine.configure(command.settings);
            break;
          case "reset":
            engine.reset();
            break;
        }
        send(ws, { type: "state", state: engine.snapshot() });
      } catch (error) {
        send(ws, {
          type: "error",
          message: publicErrorMessage(error),
        });
      }
    })();
  });
});
server.listen(port, host, () => {
  console.log(`Spray & Pray: http://${host}:${port}`);
  console.log(`${network.name} RPC: ${new URL(rpcUrl).origin}`);
  void engine
    .configure(startingSettings)
    .catch((error: unknown) =>
      console.error("Setup:", publicErrorMessage(error)),
    );
});
async function shutdown(): Promise<void> {
  engine.close();
  for (const ws of wss.clients) ws.close(1001, "Server stopping");
  wss.close();
  await vite?.close();
  server.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
