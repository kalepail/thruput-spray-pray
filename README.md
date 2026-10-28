# Spray & Pray

Hold, drag, and send a little chaos through Thruput.

A full-screen particle playground backed by real ERC20 transfers. A Cloudflare
Worker with Durable Objects signs and submits the transactions; the browser renders
a particle stream for them. Transfers circulate between 24 demo wallets. Open
the **Control room** to watch confirmed throughput and adjust load tuning.

**Try it:** https://thruput-spray-pray.sdf-ecosystem.workers.dev (Thruput Futurenet).

The same code runs hosted on Cloudflare and locally in `workerd` through Vite.
There is no Node server and no container.

## Run locally for development

The addresses in this section (`127.0.0.1`) are local development defaults: the
Vite dev server and a local Thruput node. The hosted app never uses them.

Requirements: Node.js 26.11.1+, npm, and a running current Thruput RPC
endpoint. `@thruputchain/*` installs from the public npm registry. Start your local
node separately. The application owns its signers and uses the SDK for funding
and transactions; it does not invoke the CLI.

### 1. Install

```sh
git clone https://github.com/kalepail/thruput-spray-pray.git
cd thruput-spray-pray
npm ci
```

### 2. Start the app

```sh
thruput node --block-driver instant   # in another terminal
npm run dev
```

Open **http://127.0.0.1:5177**. `npm run dev` runs the Worker and its Durable
Objects locally in `workerd` and connects to **http://127.0.0.1:9545**. The lanes
derive a four-wallet pool, check balances, and request local test HOG where
needed. First-time funding can take a few seconds per wallet; progress appears
above the canvas. There is no wallet extension, signing prompt, contract build, or
manual key setup.

Run app commands from `spray-pray`, not the experiments repository root.
The app serves the API, WebSocket, and frontend from one port.

| Variable          | Default                 | Purpose                                                   |
| ----------------- | ----------------------- | --------------------------------------------------------- |
| `THRUPUT_NETWORK` | `localnet`              | `futurenet` or `localnet`; read when `npm run dev` starts |
| `THRUPUT_RPC_URL` | `http://127.0.0.1:9545` | RPC override for the selected network                     |
| `APP_URL`         | `http://127.0.0.1:5177` | Test target: the local dev server unless set              |
| `CHROMIUM_PATH`   | `/usr/bin/chromium`     | Browser test executable                                   |

All other settings are bindings in `cloudflare.config.ts` (see
[Tuning](#tuning)). The SDK validates the Futurenet identity in
`THRUPUT_NETWORK_HASH` before funding or signing; an RPC override does not change
the selected network or its identity pin.

The demo uses public deterministic test keys and test HOG. Faucet requests are
subject to Futurenet cooldowns and quotas. Existing funded wallets are reused;
funding errors appear in the app, and setup retries on its own every few seconds.

### Network selection

Localnet is the default. To select a separately started node on a different port:

```sh
THRUPUT_RPC_URL=http://127.0.0.1:19545 npm run dev
```

`THRUPUT_NETWORK=futurenet npm run dev` runs locally against the public Futurenet
endpoint. Restart the app after changing networks or replacing an ephemeral local
node.

## Play

- **Mouse, touch, or pen:** hold and drag on the canvas. Holding still also sprays.
  Particles stream from the pointer, so a drag leaves a continuous trail.
- **Keyboard:** focus the canvas with Tab, then hold Space. Escape stops.
- **Control room:** view transaction and block statistics. Load tuning offers
  1–1,000 transactions per batch and 1–512 concurrent submission requests,
  defaulting to 256 and 96 on Futurenet (32 locally). `SPRAY_WALLETS` sets the
  wallet pool: 24 on Futurenet, 4 locally.
- **Release:** stop generating transactions. The spray ends at the pointer;
  submitted work keeps draining in the counters.
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
time; the others watch that spray live. There is no queue: a refused browser
presses again after the spray ends, and the first press wins. Opening controls, losing focus, hiding the page, disconnecting, or missing
input heartbeats for 1.5 seconds stops new work. Reloading reconnects to the
current totals; it does not replay old particles. Changing settings preserves
cumulative statistics. Reset before comparing runs.

## What actually runs

Each transaction calls the native HOG token's generated `ERC20.transfer`
binding through a public-key account's `DefaultWallet`. It transfers **one base
unit (0.0000001 HOG)** to the next wallet in a ring of 24 wallets. Each
wallet acts as both sender and receiver. HOG exposes the ERC20 interface on
Thruput; this does not use an EVM.

```
browser ──WebSocket──▶ Worker ──▶ SprayPray (coordinator, 1 object)
                                     │  lease, WebSockets, merged statistics
                                     ├──every 100 ms──▶ SprayLane × 48
                                     │                    sign · submit · poll
                                     └──▶ Placement (1 object): picks coordinator and lanes
```

- **SprayLane** runs the pipeline in `server/engine.ts` for one sender wallet; two
  lanes share each wallet. One Durable Object runs on one isolate and core, and it
  measured about 2,200 tx/s with signing and receipt parsing. 48 lanes run in
  parallel on Futurenet (8 locally), each with its own connections. Only the first
  lane of each wallet calls the faucet; the other waits up to five minutes for
  the grant, because two calls for one recipient race.
- **SprayPray** holds the browser WebSockets and the spray lease, forwards
  heartbeats to the lanes, relays submitted batches to browsers as particles
  (merged into one message every 50 ms), and merges the lanes' reports into one
  snapshot.
- **Placement** chooses the coordinator and the lane objects once. A Durable Object stays where it is
  created, and a `wnam` location hint lands anywhere in Western North America.
  Placement keeps the candidates with the shortest round trip to the RPC (Futurenet
  runs in AWS us-west-2), because batch uploads from distant data centers are an
  order of magnitude slower. The coordinator relays every heartbeat and particle,
  so it sits beside the lanes too; a coordinator in Dallas added about 200 ms to
  every click.

Signing uses Web Crypto Ed25519 behind the SDK's `Signer` interface; its signed
transactions are byte-identical to the earlier Node signer's. Transaction
construction, wallet wrapping, serialization, and canonical hashing come from
`@thruputchain/client@0.24.0` (wire format 14). The browser receives only input/control messages,
counters, public addresses, and compact particle batches.

The pipeline signs fresh batches, submits bounded JSON-RPC arrays, and polls
receipts independently. Explicit nonces and expiry heights avoid per-transaction
tip requests. Hosted, a lane sends RPC batches over a pool of HTTP/1.1 keep-alive
TLS sockets: a Worker may have only six `fetch()` calls waiting for response
headers, and the RPC answers only after it processes a whole batch. One transfer
per batch is polled often; the rest of the batch is polled once it lands.

Each sender's replay cache accepts at most 8,000 unexpired nonces per expiry
height (`kReplayCacheNoncesMaxLen`). More fail as a two-phase-commit conflict that
`getTransactionStatus` reports as `retry` (executor code 3). Resending
cannot fix that until the height expires. `server/expiry.ts` therefore fills one
height per sender up to 7,000, moves forward, never reuses a height, and waits for
new blocks when its window is full. Lanes persist the cursor, so a restart
continues past heights it already filled; a cursor beyond the current window (a
fresh local node or a Futurenet wipe) is ignored. Sustained throughput is bounded by about
7,000 transfers per wallet per block. With 24 wallets that bound (168,000 per
block) sits above Futurenet's own limit. The earlier counter-based buckets overfilled
heights after about two minutes of continuous load.

Receipts that stay missing are checked with `getTransactionStatus`. On
`retry` or `unknown` the lane resends the identical signed bytes, which keeps the
same hash and can never create a second transfer. Network failures are resent the
same way; HTTP errors are not. Futurenet answers a duplicate of an admitted transfer
with the same hash, so a rejection after a resend counts as Failed.

When the gateway answers `-32050` (a backend behind it is down), a lane pauses
sending and polling for 1 s, doubling up to 8 s, and resumes on its own. The
spray keeps its lease, and transfers do not time out to Unresolved during the
pause.

The canvas draws with **WebGL**: the GPU computes each particle's position from its
spawn values and age, so the CPU uploads only new particles. Without a hardware GPU
it falls back to Canvas 2D (`?renderer=2d` forces it). Both use the same motion and
cap device-pixel ratio at 2; WebGL uses a **160,000-particle** pool, Canvas 2D a
30,000-particle pool.

## Reading the numbers

| Metric                | Meaning                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| Attempted             | Signed transactions handed to submission                                           |
| Accepted              | RPC admission acknowledged with the expected transaction hash                      |
| Successful            | Committed receipts with successful execution                                       |
| Failed                | Explicit submission rejection or failed execution                                  |
| Unresolved            | No terminal receipt within the 60-second observation deadline                      |
| Pending               | Attempted minus successful, failed, and unresolved                                 |
| Confirmed tx/sec      | Successful transfers in complete blocks committed in the last 10 s / at least 10 s |
| Average confirmed/sec | Successful receipts / active experiment time, including signing and receipt drain  |
| Submitted/sec         | Attempts over the last five seconds (or less, just after a start) / that window    |
| Sending               | Attempts per second over five seconds while spraying; the last second after it     |

The headline must never report more than the chain did. Our transfers reach the
chain in a cycle: the 393,216 in-flight cap fills in about 2 s, those transfers
land in two or three blocks of 100,000–290,000, and sends then wait for receipts
while nearly empty blocks commit. One loaded block alone is 55k–65k tx/s, and the
earlier two-block headline showed up to 73k tx/s in a spray that sustained
~45k. The headline therefore averages over 10 s of commit time, about one cycle.

It counts our successful transfers in complete blocks that committed in the last
10 s, and divides by the time the chain took to commit them (from the commit of
the block before the oldest one), but never by less than 10 s, plus 250 ms for
tip-read jitter. Commit times are when the coordinator saw each block become the
chain tip: it reads `getChainTip` every 250 ms, and one clock times both ends.
`getBlockByHeight` is not used, because the index stores blocks about as late as
their receipts (~10 s under load). A block is complete when it committed before
the oldest waiting transfer was sent (waiting transfers sent more than 20 s ago
are left out), so no waiting transfer can be in it; with nothing pending, every
block up to the one before the tip is complete. Incomplete blocks are not
counted, so missing receipts can only make the number low.

Until the spray's first block is complete, the headline shows the transfers sent
since the spray started, divided by at least 10 s, labelled "SENDING TX / SEC".
Without that floor it read 105k at 2 s, because the cap lets ~400k go out at once.
If transfers are pending but no new block is reported for 6 s, the headline shows
0; while blocks still commit, it keeps its value for up to 15 s, because the
index can be that late. After a release it falls to 0 over 10 s.

`npm run test:headline` checks this against the chain. It sprays with random
holds (0.3–8 s) and gaps (0.5–6 s), then compares every headline value with the
best 10 s rate the chain gave our transfers, timed by `getBlockByHeight`. Three
120 s runs on the hosted app (October 28) passed:

| Seed   | Sprays | Transfers | Chain best 10 s | Headline max | Sending max |
| ------ | -----: | --------: | --------------: | -----------: | ----------: |
| 579565 |     16 | 3,894,271 |          47,697 |       41,655 |      28,518 |
| 766568 |     18 | 4,257,709 |        ≥ 50,916 |       51,422 |      39,322 |
| 971359 |     17 | 4,822,784 |          53,046 |       46,138 |      40,627 |

The second run used a stricter truth (10 s or longer runs only), which the
headline exceeded by 1.0% within the test's 3% clock margin; the corrected truth
divides shorter runs by 10 s and is at least as high.

The headline also trails the chain. At light load a block's receipts are all
counted about 1 s after it commits; with ~300,000 in flight it takes 5–7 s,
because receipt lookups scale with the number pending. The HUD shows the
measured send-to-receipt time of the transfers confirmed in the last 5 s as
"N s to confirm" (about 9–10 s at Futurenet's limit). The graph beside the headline
plots the last 60 seconds: the confirmed rate as a filled line and the sent rate
as a dashed line, so the gap between them is visible.

#### Block time and send rate

Futurenet produces blocks one at a time: the proposer executes, peers replay, SCP
agrees, each node commits, then the next block starts. Idle blocks take 2.03 s,
and each block takes about 2.1 s plus 5.5 µs per transfer, so no load keeps the
average at 2.0 s. `SPRAY_RATE` paces sends to a total rate instead of filling the
in-flight cap at once. Measured over 30-second runs with 24 wallets (chain rate:
our transfers per loaded block / that block's own interval):

| Sending  | Chain tx/s | Average block | Longest block | Receipts counted after commit |
| -------- | ---------: | ------------: | ------------: | ----------------------------: |
| Unpaced  |     46,919 |        2.75 s |        2.87 s |                         5.5 s |
| 45,000/s |     43,212 |        2.78 s |        3.31 s |                         6.5 s |
| 35,000/s |     34,105 |        2.51 s |        2.63 s |                         4.5 s |
| 25,000/s |     24,342 |        2.35 s |        2.38 s |                         2.2 s |

Pacing near the limit costs throughput without shortening blocks, so the hosted
app sends unpaced. A lower rate trades throughput for shorter blocks and faster
receipts.

Idle gaps between sprays are excluded from average time. A lost submission
response is checked using the original hash, never replaced with another
transaction. A timeout is unresolved, not proof of failure. Unresolved outcomes
stop being polled after the deadline; the chain may still commit them later.

Particles visualize **submission**, not successful commitment. A batch reaches the
canvas about 200 ms after a click: the round trip plus signing the first batch. While
a browser holds the canvas, it therefore draws predicted particles at the recent
submission rate from the first frame, at most 0.4 seconds ahead; real batches then
pay those back instead of being drawn twice. At Futurenet's limit, submissions arrive
in waves of about 10 seconds: the in-flight cap fills, then waits for receipts. The
canvas queues them and releases particles at the confirmed rate shown in the
headline, or at the smoothed submission rate until one is known. It keeps up to
12 seconds queued and slows down when less than 4 seconds remain, so a pause in
submissions thins the spray instead of cutting it off. On release, prediction
stops and anything still queued or arriving later is counted without being drawn,
so the spray ends where the click ends; particles already in flight fade out.

The scale is fixed per screen, so the spray grows with throughput; the HUD shows
it. With WebGL a laptop or larger screen (1,000,000 CSS pixels or more) draws one
particle for every three transfers, with lifetimes 1.3 times longer; a tablet one
for every four (1.2 times); a phone one for every five (1.15 times). Canvas 2D
draws one for every five. Confirmations use the same scale. When the pool would
overflow, or a frame takes more than 8 ms to draw, fewer particles are drawn per
transfer. The canvas exposes `data-emitted` (transfers represented),
`data-confirmed`, `data-drawn`, `data-draw-ms`, and `data-density` for
diagnostics. Counters are authoritative even if a slow browser
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

`scripts/deploy.sh` runs `cf deploy --mode futurenet` (profile `CF_PROFILE`, default
`default`), then polls `/api/state` until the coordinator and every lane report the
new Worker version and the app is ready. Running timers keep Durable Objects alive
across a deploy; each request carries the Worker's version timestamp, and an older
object resets itself. Browsers reconnect on their own. Set `SPRAY_PRAY_URL` when
the account's `workers.dev` URL differs from the default in the script.

The hosted app uses its own wallet seed, so local runs never share its wallets. That
seed is the Worker secret `SPRAY_WALLET_SEED`, not a value in this repository,
because anyone with the seed can sign for the hosted wallets. A lane on Futurenet
refuses to start without it. Set it once with the first deploy, or again to rotate
the wallets (fresh wallets fund themselves from the faucet on the next spray):

```sh
umask 077 && mkdir -p .local
printf '{"SPRAY_WALLET_SEED":"%s"}\n' "$(openssl rand -hex 32)" > .local/secrets.json
SPRAY_SECRETS_FILE=.local/secrets.json npm run deploy
rm .local/secrets.json
```

Later deploys keep the secret. A test deploy that sets `SPRAY_WALLET_SEED` in the
shell uses that value as a plain variable instead. The
coordinator stops after 30 idle minutes and lanes stop 2 minutes after their last
report; statistics reset when objects restart.

### Monitoring

- `GET /api/state`: the merged snapshot plus `lanes` and `coordinator` (data center
  and round trip to the RPC) and `build` (Worker version and how many lanes run
  it). `GET /api/export` returns the same snapshot; the Control room's **Export
  run** downloads it.
- Placement is chosen once and stored. To choose new objects, for example after
  the RPC moves, bump `LAYOUT_KEY` or `COORDINATOR_KEY` in `worker/placement.ts`
  and deploy.
- Workers Observability is enabled; Placement logs the objects it chooses.

### After a Futurenet wipe

After a Futurenet wipe, `/api/state` reports `Network mismatch`. Read the new base58 hash,
put it in `THRUPUT_NETWORK_HASH` in `cloudflare.config.ts`, and deploy:

```sh
curl -s -X POST https://rpc.thruput.network -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getNetworkInfo","params":{}}'
```

### Tuning

| Binding                                      | Value       | Purpose                                                     |
| -------------------------------------------- | ----------- | ----------------------------------------------------------- |
| `SPRAY_WALLETS`                              | `24`        | Wallets in the ring; each adds ~7,000 transfers per block   |
| `SPRAY_LANES`                                | `48`        | Lane objects; a multiple of `SPRAY_WALLETS`                 |
| `SPRAY_BATCH_SIZE`, `SPRAY_CONCURRENCY`      | `256`, `96` | Starting settings; concurrency is divided between lanes     |
| `SPRAY_OUTSTANDING`                          | `393216`    | Total in flight; covers 6–8 s receipts at Futurenet's limit |
| `SPRAY_RATE`                                 | `0`         | Total sends per second across lanes; 0 sends unpaced        |
| `SPRAY_POLL_CONCURRENCY`, `SPRAY_POLL_BATCH` | `8`, `1000` | Receipt lookups per lane; RPC arrays take up to 1,000       |
| `SPRAY_PROBE_INTERVAL_MS`                    | `200`       | Poll one transfer per batch often, the rest after it lands  |
| `SPRAY_RECEIPT_SAMPLE`                       | `1`         | Look up 1 in N; the rest settle from their batch's probe    |
| `SPRAY_FIRST_POLL_RATIO`                     | `0.8`       | First poll near the average receipt delay                   |
| `SPRAY_SUBMIT_RETRIES`                       | `2`         | Resend identical bytes only after a lost connection         |
| `SPRAY_STATUS_AFTER_MS`                      | `6000`      | Check scheduler status for receipts this late               |
| `SPRAY_EXPIRY_AHEAD`, `SPRAY_EXPIRY_WINDOW`  | `30`, `20`  | First expiry 30 blocks ahead; 20 heights before waiting     |
| `SPRAY_NONCES_PER_HEIGHT`                    | `7000`      | Per sender per height; the protocol limit is 8,000          |
| `SPRAY_RPC_SOCKETS`                          | `12`        | Keep-alive sockets per lane (HTTPS endpoints only)          |

Values are the Futurenet defaults. A local node uses 4 wallets, 8 lanes, concurrency
32, and 32,768 in flight. Shell variables with the same names override them at
deploy time, and `SPRAY_WORKER_NAME` deploys a test copy beside the hosted app.

Engine limits are validated: integers, at least 1 where 0 would stall the engine,
and a first-poll ratio between 0 and 2.

## Verified results

### Hosted on Cloudflare, Futurenet (October 27, 2026)

Futurenet 0.41.0, wire 14.1.1, with no other load. Failed and unresolved were 0 in
every row. Each wallet count used two lanes per wallet and 16,384 transfers in
flight per wallet.

| Configuration                                      | Successful tx/s | Receipt avg |
| -------------------------------------------------- | --------------: | ----------: |
| 16 wallets, 256 / 64, 60 s                         |          44,095 |       5.2 s |
| 24 wallets, 256 / 96, 60 s                         |          46,760 |       7.4 s |
| 32 wallets, 256 / 128, 60 s                        |          45,119 |       9.5 s |
| 24 wallets, 180 s soak (8,385,536 transfers)       |          45,245 |       8.1 s |
| 24 wallets, 262,144 in flight, 180 s               |          36,338 |       6.7 s |
| Hosted defaults, 180 s (7,919,872 transfers)       |          42,480 |       8.6 s |
| Browser journey (mouse, keyboard, touch, controls) |          17,771 |       9.8 s |

Past 24 wallets, more load adds only receipt delay: Futurenet sustains about 45k
tx/s for this workload. Blocks carry 100,000–400,000 transfers and arrive every
2.8–3.2 s.

The ramp that found this ceiling, and the plan behind it, are in
[docs/MAX-TPS-PLAN.md](docs/MAX-TPS-PLAN.md). Tests of where the ceiling comes from
(two independent sources, block periods) are in [docs/BOTTLENECK.md](docs/BOTTLENECK.md).

`npm run test:latency` sends one marked transfer per second from its own wallet
and times each step from the machine that runs it. Beside the 180-second
hosted run:

| Step                                  | Idle p50 | Under load p50 | Under load p90 |
| ------------------------------------- | -------: | -------------: | -------------: |
| `sendTransaction` answers             |   0.18 s |         0.18 s |         0.20 s |
| `getTransactionStatus` is `committed` |    1.5 s |          2.8 s |          4.5 s |
| Then `getTransactionReceipt` has it   |   0.18 s |          4.0 s |          5.4 s |
| Total                                 |    1.7 s |          6.9 s |          9.4 s |

Most of the delay under load comes after commit: receipts reach the indexer about
4 s after the scheduler reports the transfer committed.

### Hosted on Cloudflare, Futurenet (October 20, 2026)

Futurenet 0.29.2, wire 11.2.0, with no other load. Successful tx/s includes the drain
after release; failed and unresolved were 0 in every row.

| Configuration                                                 | Successful tx/s |
| ------------------------------------------------------------- | --------------: |
| Earlier Node app in a 1-vCPU container, 128 / 4               |           1,917 |
| Tuned Node app, 4-vCPU container, 4 signing threads, 256 / 32 |    9,405–12,743 |
| One Durable Object (CPU-bound)                                |     2,200–2,900 |
| 8 lanes, 256 / 32, 30 s                                       |          12,412 |
| 8 lanes, 1,000 / 16, 5-minute soak (3,540,000 transfers)      |          11,757 |
| Browser journey (mouse, keyboard, touch, controls)            |          10,692 |

While spraying, Futurenet blocks carry 25,000–41,000 transfers and stretch from
2.0 s to 2.2–3.3 s, with 2.4–2.6 s receipt delays. 32,768 transfers in flight
looked like saturation at the time; the October 27 runs show that four wallets
were the limit. These are observations of this client on a shared network, not
consensus benchmarks.

Rendering, measured in Chromium on an Apple-silicon Mac (October 28): a local
benchmark of the draw loop at 9,000–100,000 particles per second held 60 fps with
WebGL (1–4 ms of CPU per frame), and Canvas 2D fell to 7–43 fps; with the CPU
slowed 4× (a phone profile) Canvas 2D fell to 3–16 fps and WebGL still held 60.
On the hosted app at Futurenet's limit, a 30-second drag ran at 57–61 fps, drew
transfers at the confirmed rate (for example 44,903 per second as 8,980 particles),
and kept 5,700 particles per second through a pause in submissions.

Click feel, measured in Chromium against the hosted app: the first particle
appears in the first frame (about 30 ms; about 300 ms before prediction and
coordinator placement). A recorded drag that releases and keeps moving shows the
trail stopping at the release point. A 30-second drag kept a continuous stream
(11,650–13,970 transfers represented per second) at 1.8–2.8 ms draw cost per
frame.

### Local node (September 16, 2026)

The tables below record earlier configurable-wallet versions of the Node app. On
a local node the signing client was the limit, so wallet count did not matter
there; the old wallet-count sweep is retained as measurement history.

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
npm run test:latency   # Times one transfer per second through commit and receipt
npm run test:headline  # Random holds and gaps; the headline never exceeds the chain
npm run test:lease     # A second browser is refused; the lease passes on release
npm run test:security  # Public endpoints, cross-origin WebSocket, same-origin font
npm run watch:blocks   # Records each block period and size; WATCH_SECONDS, WATCH_OUTPUT
```

For a longer run:

```sh
LOAD_SECONDS=30 LOAD_BATCH=256 LOAD_CONCURRENCY=32 npm run test:load
```

Run the live checks sequentially while the demo is otherwise idle, and keep only
one sprayer per network. Browser, load, lease, and security tests target the local
dev server unless `APP_URL` names another app, for example
`APP_URL=https://thruput-spray-pray.sdf-ecosystem.workers.dev npm run test:security`.
They use that app's network. `test:load` fails if its WebSocket closes mid-run.
`LOAD_ALLOW_ERRORS=1` lets `test:load` log recoverable errors, such as a backend
pause, and still fail on any failed or unresolved transfer. `LOAD_WALLETS` checks
the app's wallet count.
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
- **Network mismatch:** verify the endpoint and `THRUPUT_NETWORK`. A Futurenet
  reset requires updating `THRUPUT_NETWORK_HASH` in `cloudflare.config.ts`.
- **Fresh node:** restart `npm run dev` so the cached wallet clients and chain tip
  are rebuilt. The deterministic addresses are funded again on the fresh chain.
- **Pending rises:** the outstanding-work limit applies backpressure. Release
  and let receipts drain; inspect Recent diagnostics before another run.
- **After prolonged use:** Apply configuration rechecks balances and tops up
  wallets below 1 HOG. Storage deposits are not transaction gas fees.
- **Many visitors at once:** one coordinator object serves every browser on one
  thread. It sends each browser about 20 particle messages and 10 state messages
  a second, so the work grows with the number of viewers. The same thread handles
  the sprayer's heartbeats; if it falls more than 1.5 seconds behind, the lease
  expires and the spray stops. A spray also has no time limit, so one browser (or
  a script that sends heartbeats) can hold the canvas for as long as it wants.

## Source map

- `worker/index.ts`: Worker entry, static assets, routing to the coordinator.
- `worker/coordinator.ts`: `SprayPray` — lease, WebSockets, particles, merged statistics.
- `worker/lane.ts`: `SprayLane` — one engine per sender wallet.
- `worker/placement.ts`: `Placement` — chooses the coordinator and lanes beside the RPC.
- `server/engine.ts`: bounded pipeline, probe polling, scheduler retry, and accounting.
- `server/chain.ts`, `server/prepare.ts`: wallet provisioning, sender shards, signing.
- `server/expiry.ts`: per-sender expiry heights within replay-cache capacity.
- `server/socket-rpc.ts`: keep-alive JSON-RPC socket pool.
- `server/signer.ts`: deterministic development signer using Web Crypto.
- `server/network.ts`: Futurenet/Localnet endpoints, identity pin, and SDK transport.
- `server/rpc.ts`: JSON-RPC batching, receipt and status validation.
- `server/commands.ts`: runtime validation of browser control messages.
- `shared/protocol.ts`: settings and telemetry types, with no browser SDK dependency.
- `src/main.ts`: pointer/keyboard input, settings, and live UI.
- `src/particles.ts`: bounded particle stream, release rate, and prediction.
- `src/particle-renderers.ts`: WebGL renderer and the Canvas 2D fallback.
- `scripts/deploy.sh`: Futurenet deploy that waits for every object to run the new version.
- `SPEC.md`, `docs/`: original specification and records of the earlier Node app.
