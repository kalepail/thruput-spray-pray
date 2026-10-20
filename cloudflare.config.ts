import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "thruput-spray-pray-worker",
    compatibilityDate: "2026-10-06",
    entrypoint,
    observability: { enabled: true },
    // The object signs and polls continuously while a browser sprays. Each WebSocket
    // message resets its CPU budget; the limits only guard against runaway work.
    limits: { cpuMs: 300_000, subrequests: 10_000_000 },
    assets: {
      notFoundHandling: "404-page",
      runWorkerFirst: ["/live", "/api/*"],
    },
    exports: {
      SprayPray: exports.durableObject({ storage: "sqlite" }),
      SprayLane: exports.durableObject({ storage: "sqlite" }),
      Placement: exports.durableObject({ storage: "sqlite" }),
      RpcLane: exports.durableObject({ state: "deleted" }),
    },
    env: {
      ASSETS: bindings.assets(),
      VERSION: bindings.versionMetadata(),
      SPRAY_PRAY: bindings.durableObject({
        worker: "thruput-spray-pray-worker",
        exportName: "SprayPray",
      }),
      SPRAY_LANE: bindings.durableObject({
        worker: "thruput-spray-pray-worker",
        exportName: "SprayLane",
      }),
      PLACEMENT: bindings.durableObject({
        worker: "thruput-spray-pray-worker",
        exportName: "Placement",
      }),
      THRUPUT_NETWORK: bindings.text("devnet"),
      THRUPUT_RPC_URL: bindings.text("https://rpc.thruput.network"),
      // Devnet identity read from groundhog_networkInfo; update after a devnet wipe.
      THRUPUT_NETWORK_HASH: bindings.text(
        "b69ec9c688b3936b5bcbfc4eebc355d39aa9e5c6f6f072cc4a05564a07435047",
      ),
      // Lanes per run; a multiple of the four wallets. Each lane uses one core.
      SPRAY_LANES: bindings.text("8"),
      // Distinct from the container's wallets, so both deployments never share them.
      SPRAY_WALLET_SEED: bindings.text("spray-and-pray/hosted-worker/v1"),
      SPRAY_BATCH_SIZE: bindings.text("1000"),
      SPRAY_CONCURRENCY: bindings.text("16"),
      // Devnet silently dropped accepted transfers with ~49k+ in flight.
      SPRAY_OUTSTANDING: bindings.text("32768"),
      SPRAY_POLL_CONCURRENCY: bindings.text("8"),
      SPRAY_POLL_BATCH: bindings.text("1000"),
      SPRAY_RPC_SOCKETS: bindings.text("12"),
      SPRAY_FIRST_POLL_RATIO: bindings.text("0.8"),
      // Poll one transfer per batch often; poll the rest once it lands.
      SPRAY_PROBE_INTERVAL_MS: bindings.text("200"),
      SPRAY_SUBMIT_RETRIES: bindings.text("2"),
      // Ask the scheduler about receipts missing this long; resend on `retry`.
      SPRAY_STATUS_AFTER_MS: bindings.text("6000"),
      // Replay caches hold at most 8,000 nonces per sender per expiry height; see
      // server/expiry.ts. Expiries start 30 blocks ahead, inside a 20-height window.
      SPRAY_EXPIRY_AHEAD: bindings.text("30"),
      SPRAY_EXPIRY_WINDOW: bindings.text("20"),
      SPRAY_NONCES_PER_HEIGHT: bindings.text("7000"),
    },
  },
});
