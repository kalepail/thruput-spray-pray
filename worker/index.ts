import { env } from "cloudflare:workers";
import { SprayPray, VERSION_HEADER } from "./coordinator.js";

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

function coordinator() {
  const ns = env.SPRAY_PRAY as DurableObjectNamespace<SprayPray>;
  // One shared instance: every browser sees the same experiment and statistics.
  return ns.get(ns.idFromName("spray-pray"), { locationHint: "wnam" });
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
      return await coordinator().fetch(forwarded.clone());
    } catch {
      // The object reset for a new version; a fresh stub reaches the new instance.
      return coordinator().fetch(forwarded);
    }
  },
} satisfies ExportedHandler<Env>;
