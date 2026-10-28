# Spray & Pray

> **Update, October 20, 2026:** the app now runs on Cloudflare Workers and Durable
> Objects instead of the Node server described below. Goals, controls, and the
> measurement contract are unchanged. See `README.md` for the current runtime.

Implemented and verified on September 16, 2026. All five workstream stages are
complete. See `README.md` for operation and `docs/verification.md` for results.

## Goal

A browser playground for real Groundhog / Thruput ERC20 transfers. Hold and drag
to spray colorful transaction particles. A Node server signs and submits the
work; the browser handles input, rendering, and live telemetry.

## Decisions

- TypeScript throughout. Vite with a small DOM-based frontend and Canvas 2D;
  Node HTTP + WebSocket server. No framework is needed for the canvas and drawer.
- Use the native HOG token's generated ERC20 binding. Each transaction transfers
  one base unit to the next wallet in a ring of `SPRAY_WALLETS` wallets. Every wallet
  acts as sender and receiver. This exercises actual token balances.
- Derive repeatable, public development keys from a fixed experiment seed on the
  server. No wallet connection or browser signing. These keys hold test HOG only.
- Default to Devnet at `https://rpc.thruput.network`, with the verified network
  identity pinned. Provision the wallet pool through the Devnet faucet and
  verify funding before enabling the canvas. Localnet remains an explicit option.
- Set the pool size per deployment with `SPRAY_WALLETS`: 24 on devnet, 4 on a
  local node. Each sender may use about 7,000 nonces per expiry height, so the
  sustained rate is bounded by about 7,000 transfers per wallet per block. Four
  wallets capped devnet near 12k tx/s; 24 wallets reach devnet's own limit of
  about 45k tx/s. Expose only batch size and concurrent submission requests as
  advanced load controls.
- Bounded live pipeline: sign fresh batches, submit concurrent JSON-RPC batches,
  independently poll receipts. Yield between signing batches. Cap outstanding
  work so a slow node cannot create an unbounded queue.
- Use native Node Ed25519 behind the SDK Signer interface. Keep transaction
  encoding, hashing, wallet authorization, and generated ERC20 calls in the SDK.
- A single server-owned experiment is shared by connected browsers. One browser
  controls a spray at a time. Others see the canvas and statistics. Disconnect,
  blur, pointer cancellation, page hiding, Escape, or an expired input heartbeat
  stops new submissions. Already submitted work drains normally.

## Measurement contract

- Attempted: signed transactions handed to submission.
- Accepted: RPC admission acknowledged with the expected canonical hash.
- Successful: committed receipt with successful execution.
- Failed: explicit admission rejection or committed execution failure.
- Unresolved: no terminal result before the receipt deadline, including ambiguous
  transport outcomes. Never automatically replace an ambiguous transaction.
- Pending: attempted minus successful, failed, and unresolved.
- Live TPS: successful receipts observed in the trailing five seconds / five.
- Average TPS: successful receipts / elapsed experiment work time, including
  signing, submission, and receipt drain; idle gaps between sprays are excluded.
- Submission TPS is separate. Labels describe observed demo throughput, not
  global network TPS or a production consensus benchmark.
- Average successful transactions per block divides successes by distinct receipt
  heights containing this experiment's successful transfers. Empty and failed-only
  blocks are excluded; the contributing block count is displayed alongside it.
- Every submitted transaction emits one particle. Batch telemetry includes exact
  counts and pointer origin. Rendering has a bounded particle pool; old particles
  can expire or be recycled without altering transaction counters.
- Keep recent error details and an exportable JSON run summary. Reset only when
  the pipeline has drained. Configuration changes also require an idle pipeline.

## Interaction and visual direction

A near-black, full-viewport drawing field with warm off-white typography, a lime
accent, and vivid multicolor particle trails. Sparse fixed chrome: experiment
identity in the upper left, connection status and a controls button in the upper
right, live confirmed TPS at the bottom. The empty canvas gives a clear hold-and-
drag invitation, then recedes during use. A slide-out control panel contains the
load controls, outcome counts, rate history, and measurement notes.

Support mouse, touch, and pen through pointer capture. Provide a keyboard spray
at the canvas center, visible focus states, a reduced-motion mode, and responsive
controls. Errors remain readable without opening developer tools.

## Workstream

1. Inspect the docs, examples, benchmarks, SDKs, and RPC workflow. Record this
   spec and commit it.
2. Implement the server, deterministic signer, funding, bounded load engine,
   batched RPC, receipt accounting, and lifecycle controls. Unit-test accounting,
   ambiguous responses, backpressure, and cancellation. Commit the engine.
3. Implement the full-screen canvas, particle renderer, input controller,
   telemetry display, and settings drawer. Build and check types. Commit the UI.
4. Start a compatible local node; verify real transfer receipts and balance
   changes. Exercise sustained load and multiple pool sizes. Browser-test actual
   drag input, release/blur/disconnect, drawer controls, and mobile layout.
5. Review all changes, fix issues, document measured results and reproducible
   commands, run the final checks, and commit. Leave the demo ready for review.

## Acceptance

- A fresh install can build and start the server and browser application.
- The browser starts without wallet setup; funding progress is visible.
- Dragging produces real ERC20 transfers and colorful transaction particles.
- Releasing input stops generation promptly, and pending receipts drain.
- Exactly `SPRAY_WALLETS` wallets are provisioned and used regardless of
  load-tuning settings.
- Success is established by execution receipts; timeouts are not called failures.
- Memory, submission concurrency, receipt polling, and WebSocket buffering are bounded.
- Tests cover meaningful failure modes and at least one real-node browser journey.
- Measured throughput is reported honestly, including any local bottleneck.
