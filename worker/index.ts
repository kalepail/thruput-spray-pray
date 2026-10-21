import { env } from "cloudflare:workers";
import { VERSION_HEADER } from "./coordinator.js";
import { coordinatorStub, type Placement } from "./placement.js";

export { SprayPray } from "./coordinator.js";
export { SprayLane } from "./lane.js";
export { Placement } from "./placement.js";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

// One shared coordinator: every browser sees the same experiment and statistics.
// Placement chooses it once; each isolate caches the name.
let coordinatorName: Promise<string> | undefined;
async function coordinator() {
  coordinatorName ??= (env.PLACEMENT as DurableObjectNamespace<Placement>)
    .getByName("placement")
    .coordinator()
    .catch((error: unknown) => {
      coordinatorName = undefined;
      throw error;
    });
  return coordinatorStub(await coordinatorName);
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const live = pathname === "/live";
    if (!live && pathname !== "/api/state" && pathname !== "/api/export")
      return env.ASSETS.fetch(request);
    if (live) {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("Expected WebSocket", { status: 426 });
      if (!sameOrigin(request)) return new Response(null, { status: 403 });
    }
    const forwarded = new Request(request);
    forwarded.headers.set(VERSION_HEADER, env.VERSION.timestamp);
    try {
      return await (await coordinator()).fetch(forwarded.clone());
    } catch {
      // The object reset for a new version; a fresh stub reaches the new instance.
      return (await coordinator()).fetch(forwarded);
    }
  },
} satisfies ExportedHandler<Env>;
