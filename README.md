# Spray & Pray

Hold, drag, and send a little chaos through Thruput.

A full-screen particle playground backed by real ERC20 transfers. A Cloudflare
Worker with Durable Objects signs and submits the transactions; the browser renders
one particle for each attempt. Transfers circulate between four demo wallets. Open
the **Control room** to watch confirmed throughput and adjust load tuning.

The same code runs locally (in `workerd`, through Vite) and hosted on Cloudflare.
There is no Node server and no container.

## Run the app locally

Requirements: Node.js 26.11.1+, npm, read access to `@thruputchain/*` on
GitHub Packages, and a running current Thruput RPC endpoint. Start your local
node separately. The application owns its signers and uses the SDK for funding
and transactions; it does not invoke the CLI.

### 1. Install

From the `groundhog-experiments` repository root:

```sh
cd spray-pray
npm ci
```

`.npmrc` selects GitHub Packages for `@thruputchain/*`. Configure package-read
authentication in your user npm configuration. If it references `GH_NPM_TOKEN`,
you can supply the token through the environment:

```sh
GH_NPM_TOKEN="$(gh auth token)" npm ci
```

### 2. Start the app

```sh
thruput node --block-driver instant   # in another terminal
npm run dev
```

Open **http://127.0.0.1:5177**. `npm run dev` runs the Worker and its Durable
Objects locally in `workerd` and connects to **http://127.0.0.1:9545**. The lanes
derive the fixed four-wallet pool, check balances, and request local test HOG where
needed. First-time funding can take a few seconds per wallet; progress appears
above the canvas. There is no wallet extension, signing prompt, contract build, or
manual key setup.

Run app commands from `spray-pray`, not the experiments repository root.
The app serves the API, WebSocket, and frontend from one port.

| Variable          | Default                 | Purpose                                                |
| ----------------- | ----------------------- | ------------------------------------------------------ |
| `THRUPUT_NETWORK` | `localnet`              | `devnet` or `localnet`; read when `npm run dev` starts |
| `THRUPUT_RPC_URL` | `http://127.0.0.1:9545` | RPC override for the selected network                  |
| `APP_URL`         | `http://127.0.0.1:5177` | Browser/load/security test target                      |
| `CHROMIUM_PATH`   | `/usr/bin/chromium`     | Browser test executable                                |

All other settings are bindings in `cloudflare.config.ts` (see
[Tuning](#tuning)). The SDK validates the devnet identity in
`THRUPUT_NETWORK_HASH` before funding or signing; an RPC override does not change
the selected network or its identity pin.

The demo uses public deterministic test keys and test HOG. Faucet requests are
subject to devnet cooldowns and quotas. Existing funded wallets are reused;
funding errors appear in the app, and setup retries on its own every few seconds.

### Network selection

Localnet is the default. To select a separately started node on a different port:

```sh
THRUPUT_RPC_URL=http://127.0.0.1:19545 npm run dev
```

`THRUPUT_NETWORK=devnet npm run dev` runs locally against the public devnet
endpoint. Restart the app after changing networks or replacing an ephemeral local
node.

## Play

- **Mouse, touch, or pen:** hold and drag on the canvas. Holding still also sprays.
  Particles stream from the pointer, so a drag leaves a continuous trail.
- **Keyboard:** focus the canvas with Tab, then hold Space. Escape stops.
- **Control room:** view transaction and block statistics. Load tuning offers
  1–1,000 transactions per batch and 1–32 concurrent submission requests,
  defaulting to 256 and 32. The wallet pool is fixed at four.
- **Release:** stop generating transactions. Submitted work continues draining.
- **Export run:** download the current server snapshot as JSON.
- **Reset stats:** start fresh once the pipeline is idle.
- **Reduced motion:** keep particles at their emission positions while they fade.
  This defaults to the browser's reduced-motion preference.

Particles radiate in all directions, including when holding still. The pending
limit and average receipt delay in Control room explain flow control: at most
32,768 transfers can be signing or awaiting a terminal outcome. When that budget
fills, generation pauses until receipts free capacity. This is not an execution
error and does not drop submitted transfers.

All browsers share one experiment and its statistics. Only one can spray at a
time. Opening controls, losing focus, hiding the page, disconnecting, or missing
input heartbeats for 1.5 seconds stops new work. Reloading reconnects to the
current totals; it does not replay old particles. Changing settings preserves
cumulative statistics. Reset before comparing runs.

## What actually runs

Each transaction calls the native HOG token's generated `ERC20.transfer`
binding through a public-key account's `DefaultWallet`. It transfers **one base
unit (0.0000001 HOG)** to the next wallet in a fixed four-wallet ring. Each
wallet acts as both sender and receiver. HOG exposes the ERC20 interface on
Thruput; this does not use an EVM.

```
browser ──WebSocket──▶ Worker ──▶ SprayPray (coordinator, 1 object)
                                     │  lease, WebSockets, merged statistics
                                     ├──every 100 ms──▶ SprayLane × 8
                                     │                    sign · submit · poll
                                     └──▶ Placement (1 object): picks the lanes
```

- **SprayLane** runs the pipeline in `server/engine.ts` for one sender wallet; two
  lanes share each wallet. One Durable Object runs on one isolate and core, and it
  measured about 2,200 tx/s with signing and receipt parsing. Eight lanes run in
  parallel, each with its own connections.
- **SprayPray** holds the browser WebSockets and the spray lease, forwards
  heartbeats to the lanes, draws each submitted batch, and merges the lanes'
  reports into one snapshot.
- **Placement** chooses the coordinator and the lane objects once. A Durable Object stays where it is
  created, and a `wnam` location hint lands anywhere in Western North America.
  Placement keeps the candidates with the shortest round trip to the RPC (devnet
  runs in AWS us-west-2), because batch uploads from distant data centers are an
  order of magnitude slower. The coordinator relays every heartbeat and particle,
  so it sits beside the lanes too; a coordinator in Dallas added about 200 ms to
  every click.

Signing uses Web Crypto Ed25519 behind the SDK's `Signer` interface; its signed
transactions are byte-identical to the earlier Node signer's. Transaction
construction, wallet wrapping, serialization, and canonical hashing come from
`@thruputchain/client@0.18.0`. The browser receives only input/control messages,
counters, public addresses, and compact particle batches.

The pipeline signs fresh batches, submits bounded JSON-RPC arrays, and polls
receipts independently. Explicit nonces and expiry heights avoid per-transaction
tip requests. Hosted, a lane sends RPC batches over a pool of HTTP/1.1 keep-alive
TLS sockets: a Worker may have only six `fetch()` calls waiting for response
headers, and the RPC answers only after it processes a whole batch. One transfer
per batch is polled often; the rest of the batch is polled once it lands.

Each sender's replay cache accepts at most 8,000 unexpired nonces per expiry
height (`kReplayCacheNoncesMaxLen`). More fail as a two-phase-commit conflict that
`groundhog_getTransactionStatus` reports as `retry` (executor code 3). Resending
cannot fix that until the height expires. `server/expiry.ts` therefore fills one
height per sender up to 7,000, moves forward, never reuses a height, and waits for
new blocks when its window is full. Lanes persist the cursor, so a restart
continues past heights it already filled. Sustained throughput is bounded by about
7,000 transfers per wallet per block. The earlier counter-based buckets overfilled
heights after about two minutes of continuous load.

Receipts that stay missing are checked with `groundhog_getTransactionStatus`. On
`retry` or `unknown` the lane resends the identical signed bytes, which keeps the
same hash and can never create a second transfer. Network failures are resent the
same way; HTTP errors are not. Devnet answers a duplicate of an admitted transfer
with the same hash, so a rejection after a resend counts as Failed.

The canvas uses a fixed **24,000-particle** pool, draws each color in one pass, and
caps device-pixel ratio at 2.

## Reading the numbers

| Metric                | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| Attempted             | Signed transactions handed to submission                                          |
| Accepted              | RPC admission acknowledged with the expected transaction hash                     |
| Successful            | Committed receipts with successful execution                                      |
| Failed                | Explicit submission rejection or failed execution                                 |
| Unresolved            | No terminal receipt within the 60-second observation deadline                     |
| Pending               | Attempted minus successful, failed, and unresolved                                |
| Confirmed tx/sec      | Successful transfers in the last three completed blocks / their interval          |
| Average confirmed/sec | Successful receipts / active experiment time, including signing and receipt drain |
| Submitted/sec         | Attempts over the last five seconds (or less, just after a start) / that window   |
| Sending               | Attempts in the last second                                                       |

Receipts arrive in block-sized lumps: under load a block carries 25,000–40,000
of these transfers every ~2.5 s, so any short time window swings with block
timing. The headline therefore measures completed blocks. Before two blocks land
it shows the average since the spray began; after work ends, a trailing window
decays to zero.

Idle gaps between sprays are excluded from average time. A lost submission
response is checked using the original hash, never replaced with another
transaction. A timeout is unresolved, not proof of failure. Unresolved outcomes
stop being polled after the deadline; the chain may still commit them later.

Particles visualize **submission**, not successful commitment. A batch reaches the
canvas about 200 ms after a click: the round trip plus signing the first batch. While
a browser holds the canvas, it therefore draws predicted particles at the recent
submission rate from the first frame, at most 0.4 seconds ahead; real batches then
pay those back instead of being drawn twice. Submitted batches arrive in pulses,
because devnet confirms in blocks, so the canvas queues them and releases particles
at the smoothed rate (never more than 0.5 seconds behind). On release, prediction
stops and anything still queued or arriving later is counted without being drawn,
so the spray ends where the click ends; particles already in flight fade out.

Up to one particle is drawn per attempted transaction. Above about 8,000 per second,
or when a frame takes more than 8 ms to draw, fewer particles are drawn per
transaction so live particles never overflow the 24,000-particle pool. The canvas
exposes `data-emitted` (transfers represented), `data-drawn`, `data-draw-ms`, and
`data-density` for diagnostics. Counters are authoritative even if a slow browser
misses a connection or cannot display every particle.

HOG has no gas fee, but wallet replay-cache storage locks and releases HOG deposits.
Sender free balances therefore do not change solely by the amount transferred. The
live test isolates a recipient that makes no outgoing transfers to verify an
exact token balance increase.

The Control room's **Avg successful / block** is successful transfers divided by
distinct receipt heights containing successful transfers from this experiment.
Empty blocks and failed-only blocks are excluded. The denominator is displayed
as **Blocks with transfers**. These metrics reset with the other session stats.
Average receipt delay measures submission to observed committed execution,
including node, RPC, and polling time; explicit admission rejections and
unresolved outcomes are excluded.

## Hosting on Cloudflare

```sh
npm run deploy
```

`scripts/deploy.sh` runs `cf deploy --mode devnet` (profile `CF_PROFILE`, default
`default`), then polls `/api/state` until the coordinator and every lane report the
new Worker version and the app is ready. Running timers keep Durable Objects alive
across a deploy; each request carries the Worker's version timestamp, and an older
object resets itself. Browsers reconnect on their own. Set `SPRAY_PRAY_URL` when
the account's `workers.dev` URL differs from the default in the script.

The hosted app uses its own wallet seed, so local runs never share its wallets. The
coordinator stops after 30 idle minutes and lanes stop 2 minutes after their last
report; statistics reset when objects restart.

After a devnet wipe, `/api/state` reports `Network mismatch`. Read the new hash,
put it in `THRUPUT_NETWORK_HASH` in `cloudflare.config.ts`, and deploy:

```sh
curl -s -X POST https://rpc.thruput.network -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"groundhog_networkInfo","params":[]}'
```

### Tuning

| Binding                                      | Value       | Purpose                                                    |
| -------------------------------------------- | ----------- | ---------------------------------------------------------- |
| `SPRAY_LANES`                                | `8`         | Lane objects; a multiple of the four wallets               |
| `SPRAY_BATCH_SIZE`, `SPRAY_CONCURRENCY`      | `256`, `32` | Starting settings; concurrency is divided between lanes    |
| `SPRAY_OUTSTANDING`                          | `32768`     | Total in flight; this already saturates devnet             |
| `SPRAY_POLL_CONCURRENCY`, `SPRAY_POLL_BATCH` | `8`, `1000` | Receipt lookups per lane; RPC arrays take up to 1,000      |
| `SPRAY_PROBE_INTERVAL_MS`                    | `200`       | Poll one transfer per batch often, the rest after it lands |
| `SPRAY_FIRST_POLL_RATIO`                     | `0.8`       | First poll near the average receipt delay                  |
| `SPRAY_SUBMIT_RETRIES`                       | `2`         | Resend identical bytes only after a lost connection        |
| `SPRAY_STATUS_AFTER_MS`                      | `6000`      | Check scheduler status for receipts this late              |
| `SPRAY_EXPIRY_AHEAD`, `SPRAY_EXPIRY_WINDOW`  | `30`, `20`  | First expiry 30 blocks ahead; 20 heights before waiting    |
| `SPRAY_NONCES_PER_HEIGHT`                    | `7000`      | Per sender per height; the protocol limit is 8,000         |
| `SPRAY_RPC_SOCKETS`                          | `12`        | Keep-alive sockets per lane (HTTPS endpoints only)         |

Engine limits are validated: integers, at least 1 where 0 would stall the engine,
and a first-poll ratio between 0 and 2.

## Verified results

### Hosted on Cloudflare, devnet (October 20, 2026)

Devnet 0.29.2, wire 11.2.0, with no other load. Successful tx/s includes the drain
after release; failed and unresolved were 0 in every row.

| Configuration                                                 | Successful tx/s |
| ------------------------------------------------------------- | --------------: |
| Earlier Node app in a 1-vCPU container, 128 / 4               |           1,917 |
| Tuned Node app, 4-vCPU container, 4 signing threads, 256 / 32 |    9,405–12,743 |
| One Durable Object (CPU-bound)                                |     2,200–2,900 |
| 8 lanes, 256 / 32, 30 s                                       |          12,412 |
| 8 lanes, 1,000 / 16, 5-minute soak (3,540,000 transfers)      |          11,757 |
| Browser journey (mouse, keyboard, touch, controls)            |          10,692 |

While spraying, devnet blocks carry 25,000–41,000 transfers and stretch from
2.0 s to 2.2–3.3 s, with 2.4–2.6 s receipt delays. 32,768 transfers in flight
already saturate devnet. These are observations of this client on a shared
network, not consensus benchmarks.

### Local node (September 16, 2026)

The tables below record earlier configurable-wallet versions of the Node app. The
current demo uses four wallets; the old wallet-count sweep is retained as
measurement history.

Measured on September 16, 2026, on this workstation with a 500 ms interval local node,
Node **22.23.1**, and the compiled application. Signing is inside the timed
pipeline. The first three load runs held the trigger for ten seconds; the
128-wallet run held it for twenty seconds. Each then drained receipts.

| Wallets | Successful transfers | Average successful tx/sec | Timed work incl. drain |
| ------: | -------------------: | ------------------------: | ---------------------: |
|       2 |               59,904 |                     5,599 |               10.699 s |
|      16 |               59,904 |                     5,563 |               10.769 s |
|      64 |               60,416 |                     5,613 |               10.763 s |
|     128 |              109,184 |                     5,274 |               20.701 s |

All four runs had **zero failed and zero unresolved transfers**. The final production
browser journey committed **85,248 transfers at 5,090 tx/sec** over 16.748 seconds
of active work, with the same zero-error outcome. See
[the test record](docs/verification.md); its profiling commands belong to that
earlier Node app.

## Tests

```sh
npm run check          # Worker types, TypeScript, unit tests, formatting, production build
npm run test:live      # Real local receipts and exact recipient balance delta
npm run test:browser   # Mouse, keyboard, touch, controls, lifecycle; app required
npm run test:load      # 10-second run against the running app's selected network
npm run test:lease     # A second browser is refused; the lease passes on release
npm run test:security  # Public endpoints, cross-origin WebSocket, same-origin font
```

For a longer run:

```sh
LOAD_SECONDS=30 LOAD_BATCH=256 LOAD_CONCURRENCY=32 npm run test:load
```

Run the live checks sequentially while the demo is otherwise idle, and keep only
one sprayer per network. Browser, load, lease, and security tests use the network
of their `APP_URL` app. `test:load` fails if its WebSocket closes mid-run.
`test:browser` restores the app's starting settings when it finishes. Browser
screenshots and machine-readable results go to ignored `test-results/`.
Browser tests use headless Chromium and do not require a wallet extension.

Chromium's sandbox is explicitly enabled by default. A container that cannot
support it can opt out with `CHROMIUM_DISABLE_SANDBOX=1`; use that exception only
with a trusted test target. There is no automatic fallback to an unsandboxed browser.

Inter is bundled from the exact, lockfile-pinned `@fontsource-variable/inter`
package and served from the app's origin. The font license is distributed at
`/fonts/OFL.txt`. The page does not fetch a stylesheet or font from a third party.

## Troubleshooting

- **Connection fails:** check the selected network and RPC URL. Start the local
  node separately. Setup retries on its own.
- **Funding fails:** the control panel shows the affected wallet and faucet error.
  Wait for any reported cooldown or restore faucet availability; setup retries.
  Existing funded wallets are reused.
- **Network mismatch:** verify the endpoint and `THRUPUT_NETWORK`. A devnet
  reset requires updating `THRUPUT_NETWORK_HASH` in `cloudflare.config.ts`.
- **Fresh node:** restart `npm run dev` so the cached wallet clients and chain tip
  are rebuilt. The deterministic addresses are funded again on the fresh chain.
- **Pending rises:** the outstanding-work limit applies backpressure. Release
  and let receipts drain; inspect Recent diagnostics before another run.
- **After prolonged use:** Apply configuration rechecks balances and tops up
  wallets below 1 HOG. Storage deposits are not transaction gas fees.

## Source map

- `worker/index.ts`: Worker entry, static assets, routing to the coordinator.
- `worker/coordinator.ts`: `SprayPray` — lease, WebSockets, particles, merged statistics.
- `worker/lane.ts`: `SprayLane` — one engine per sender wallet.
- `worker/placement.ts`: `Placement` — chooses lanes beside the RPC.
- `server/engine.ts`: bounded pipeline, probe polling, scheduler retry, and accounting.
- `server/chain.ts`, `server/prepare.ts`: wallet provisioning, sender shards, signing.
- `server/expiry.ts`: per-sender expiry heights within replay-cache capacity.
- `server/socket-rpc.ts`: keep-alive JSON-RPC socket pool.
- `server/signer.ts`: deterministic development signer using Web Crypto.
- `server/network.ts`: Devnet/Localnet endpoints, identity pin, and SDK transport.
- `server/rpc.ts`: JSON-RPC batching, receipt and status validation.
- `server/commands.ts`: runtime validation of browser control messages.
- `shared/protocol.ts`: settings and telemetry types, with no browser SDK dependency.
- `src/main.ts`: pointer/keyboard input, settings, and live UI.
- `src/particles.ts`: bounded Canvas 2D renderer.
- `SPEC.md`: original specification and workstream.
