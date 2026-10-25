import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

// Config evaluates in Node, so shell variables can override the defaults below.
const shell =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};

// `npm run dev` runs against a local node, like the other experiments.
// `npm run deploy` passes `--mode devnet` for the hosted app.
export default defineConfig(({ mode }) => {
  const network =
    shell.THRUPUT_NETWORK ?? (mode === "devnet" ? "devnet" : "localnet");
  const devnet = network === "devnet";
  return {
    worker: {
      name: "thruput-spray-pray",
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
      },
      env: {
        ASSETS: bindings.assets(),
        VERSION: bindings.versionMetadata(),
        SPRAY_PRAY: bindings.durableObject({
          worker: "thruput-spray-pray",
          exportName: "SprayPray",
        }),
        SPRAY_LANE: bindings.durableObject({
          worker: "thruput-spray-pray",
          exportName: "SprayLane",
        }),
        PLACEMENT: bindings.durableObject({
          worker: "thruput-spray-pray",
          exportName: "Placement",
        }),
        THRUPUT_NETWORK: bindings.text(network),
        THRUPUT_RPC_URL: bindings.text(
          shell.THRUPUT_RPC_URL ??
            (devnet ? "https://rpc.thruput.network" : "http://127.0.0.1:9545"),
        ),
        // Devnet identity read from getNetworkInfo; update after a devnet wipe.
        THRUPUT_NETWORK_HASH: bindings.text(
          "6RgqYi69r94rCG1qKZ5NfCMAxonNAMXbDsFZMgGwgP2J",
        ),
        // Lanes per run; a multiple of the four wallets. Each lane uses one core.
        SPRAY_LANES: bindings.text("8"),
        // Public test keys. The hosted app uses its own seed so local runs never share
        // its wallets or devnet's in-flight budget for them.
        SPRAY_WALLET_SEED: bindings.text(
          devnet
            ? "spray-and-pray/hosted-worker/v1"
            : "spray-and-pray/local-demo/v1",
        ),
        SPRAY_BATCH_SIZE: bindings.text("256"),
        SPRAY_CONCURRENCY: bindings.text("32"),
        // 32,768 in flight already saturates devnet; more only adds receipt delay.
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
  };
});
