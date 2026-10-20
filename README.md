# Spray & Pray

Hold, drag, and send a little chaos through Thruput.

A full-screen particle playground backed by real ERC20 transfers. Node signs
and submits the transactions; the browser renders one particle for each attempt.
Transfers circulate between four demo wallets. Open the **Control room** to
watch confirmed throughput and adjust load tuning.

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
npm run dev
```

Open **http://127.0.0.1:5177**. The Node server connects to
**http://127.0.0.1:9545**, derives its fixed four-wallet pool, checks
balances, and requests local test HOG where needed. First-time funding can take
a few seconds per wallet; progress appears above the canvas. There is
no wallet extension, signing prompt, contract build, or manual key setup.

For the compiled application:

```sh
npm run build
npm start
```

Run app commands from `spray-pray`, not the experiments repository root.
Both modes serve the API, WebSocket, and frontend from one port.

| Environment variable | Default                 | Purpose                                   |
| -------------------- | ----------------------- | ----------------------------------------- |
| `PORT`               | `5177`                  | Application port                          |
| `HOST`               | `127.0.0.1`             | Application bind address                  |
| `THRUPUT_NETWORK`    | `localnet`              | Network selection: `devnet` or `localnet` |
| `THRUPUT_RPC_URL`    | `http://127.0.0.1:9545` | RPC override for the selected network     |
| `APP_URL`            | `http://127.0.0.1:5177` | Browser/load test target                  |
| `CHROMIUM_PATH`      | `/usr/bin/chromium`     | Browser test executable                   |

Devnet is pinned to network ID
`0xabb9cdbc56285d0e71c9845273ca06211fedf7ee2f58c43cfac6060f9402aa0f`.
The SDK validates that identity before funding or signing. An RPC override does
not change the selected network or its identity pin.

The demo uses public deterministic test keys and test HOG. Faucet requests are
subject to Devnet cooldowns and quotas. Existing funded wallets are reused;
funding errors appear in the app and can be retried through Apply configuration.
Environment variables are read from the process; `.env` files are not loaded.

### Network selection

Localnet is the default. To select a separately started node on a different port:

```sh
THRUPUT_RPC_URL=http://127.0.0.1:19545 npm run dev
```

Localnet defaults to `http://127.0.0.1:9545` and the zero network identity. For a
different local port, set `THRUPUT_RPC_URL`. The same network selection
applies to the live test and profiling scripts. Restart the app after changing
networks or replacing an ephemeral local node. `THRUPUT_NETWORK=devnet` selects
the public endpoint. Devnet rollout is deferred until its RPC/runtime supports
client 0.18.0, including decimal-string heights; the network hash alone does not
establish compatibility.

## Play

- **Mouse, touch, or pen:** hold and drag on the canvas. Holding still also sprays.
- **Keyboard:** focus the canvas with Tab, then hold Space. Escape stops.
- **Control room:** view transaction and block statistics. Load tuning offers
  1–256 transactions per batch and 1–16 concurrent submission requests, defaulting
  to 128 and 4. The wallet pool is fixed at four.
- **Release:** stop generating transactions. Submitted work continues draining.
- **Export run:** download the current server snapshot as JSON.
- **Reset stats:** start fresh once the pipeline is idle.
- **Reduced motion:** keep particles at their emission positions while they fade.
  This defaults to the browser's reduced-motion preference.

Particles radiate in all directions, including when holding still. The pending
limit and average receipt delay in Control room explain flow control: at most
8,192 transfers can be signing or awaiting a terminal outcome. When that budget
fills, generation pauses until receipts free capacity. This is not an execution
error and does not drop submitted transfers.

All browsers connected to one server share the experiment and its statistics.
Only one can spray at a time. Opening controls, losing focus, hiding the page,
disconnecting, or missing input heartbeats for 1.5 seconds stops new work.
Reloading reconnects to the server's current totals; it does not replay old particles.
Changing settings preserves cumulative statistics. Reset before comparing runs.

## What actually runs

Each transaction calls the native HOG token's generated `ERC20.transfer`
binding through a public-key account's `DefaultWallet`. It transfers **one base
unit (0.0000001 HOG)** to the next wallet in a fixed four-wallet ring. Each
wallet acts as both sender and receiver. HOG exposes the ERC20 interface on
Thruput; this does not use an EVM.

Increasing wallet count did not reliably increase throughput in this experiment.
Extra wallets can help a workload limited by per-account scheduling, but they do
not add signing CPU or RPC capacity. The demo therefore fixes the pool at four
and keeps the load controls that measurably affect its submission pipeline.

The server uses native Node Ed25519 behind the SDK's `Signer` interface.
Transaction construction, wallet wrapping, serialization, and canonical hashing
come from `@thruputchain/client@0.18.0`. The browser receives only input/control
messages, counters, public addresses, and compact particle batches.

The pipeline signs fresh batches, submits bounded JSON-RPC arrays, and polls
receipts independently. Explicit nonces and expiry heights avoid per-transaction
tip requests. Work is bounded to **8,192 outstanding transfers**, with at most
four concurrent receipt batches of 256. Signing yields to the event loop.
The canvas uses a fixed **24,000-particle** pool and caps device-pixel ratio at 2.

## Reading the numbers

| Metric                | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| Attempted             | Signed transactions handed to submission                                          |
| Accepted              | RPC admission acknowledged with the expected transaction hash                     |
| Successful            | Committed receipts with successful execution                                      |
| Failed                | Explicit submission rejection or failed execution                                 |
| Unresolved            | No terminal receipt within the 60-second observation deadline                     |
| Pending               | Attempted minus successful, failed, and unresolved                                |
| Confirmed tx/sec      | Successful receipts observed over the last five seconds / five                    |
| Average confirmed/sec | Successful receipts / active experiment time, including signing and receipt drain |
| Submitted/sec         | Attempts over the last five seconds / five                                        |

Idle gaps between sprays are excluded from average time. A lost submission
response is checked using the original hash, never replaced with another
transaction. A timeout is unresolved, not proof of failure. Unresolved outcomes
stop being polled after the deadline; the chain may still commit them later.

Particles visualize **submission**, not successful commitment. One particle is
emitted per attempted transaction; old particles expire or are recycled without
changing counters. Counters are authoritative even if a slow browser misses a
connection or cannot display every particle simultaneously.

HOG has no gas fee, but wallet replay-cache storage locks and releases HOG deposits. Sender
free balances therefore do not change solely by the amount transferred. The
live test isolates a recipient that makes no outgoing transfers to verify an
exact token balance increase.

## Initial verified results

The tables below record earlier configurable-wallet versions. The current demo
uses four wallets; the old wallet-count sweep is retained as measurement history.

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
of active work, with the same zero-error outcome. That journey includes real
mouse motion and screenshot capture while rendering particles.

These are single-workstation, local-development-node observations, not public
network or production consensus benchmarks. They include this client's signing,
submission, and polling overhead. Similar rates across wallet counts do not
establish a chain maximum. See [the test record](docs/verification.md).

### Throughput follow-up

The updated receipt poller refills four independent request slots instead of
waiting for the slowest request in each round. The outstanding-work budget also
counts each transaction once, rather than reserving space twice for some batches.

On the user's running local node, ten-second checks improved from **5,675 to
6,778 confirmed tx/s** at four concurrent requests and **4,614 to 5,673 tx/s**
at sixteen. The updated browser test committed **115,200 transfers at 6,443 tx/s**.
All those runs drained with zero failures or unresolved results.

Use **4 concurrent requests** as the starting point. Sixteen requests created
more contention and longer receipt delays in these checks. Preparation/signing
alone reached about 18,000 transactions per second, but that excludes submission
and receipt work and is not chain throughput. This follow-up used the node's
default block driver, not the original 500 ms interval setup.

The Control room's **Avg successful / block** is successful transfers divided by
distinct receipt heights containing successful transfers from this experiment.
Empty blocks and failed-only blocks are excluded. The denominator is displayed
as **Blocks with transfers**. These metrics reset with the other session stats.
Average receipt delay measures submission to observed committed execution,
including node, RPC, and polling time; explicit admission rejections and
unresolved outcomes are excluded.

Reproduce the local diagnostics against an otherwise idle local node:

```sh
THRUPUT_NETWORK=localnet npm run profile:prepare
THRUPUT_NETWORK=localnet npm run profile:load
THRUPUT_NETWORK=localnet LOAD_CONCURRENCY=16 npm run profile:load
```

The first command prepares/signs without submitting benchmark transfers. The
load commands use an isolated engine and report preparation, submission, and
poll-batch latency. They submit real transfers on the same node, but do not reset
the running browser app's statistics.

## Tests

```sh
npm run check          # TypeScript, unit tests, formatting, production build
npm run test:live      # Real local receipts and exact recipient balance delta
npm run test:browser   # Mouse, keyboard, touch, controls, lifecycle; app required
npm run test:load      # 10-second run against the running app's selected network
```

For a longer run:

```sh
LOAD_SECONDS=30 npm run test:load
```

Run the live checks sequentially while the demo is otherwise idle. Live and
profiling commands default to Localnet; use `THRUPUT_RPC_URL` to select its endpoint for
checks. Browser and load tests use the network of their `APP_URL` server.
Browser screenshots and machine-readable results go to ignored `test-results/`.
The fixed-pool load result is written to `test-results/load-run.json`.
Browser tests use headless Chromium and do not require a wallet extension.

Chromium's sandbox is explicitly enabled by default. A container that cannot
support it can opt out with `CHROMIUM_DISABLE_SANDBOX=1`; use that exception only
with a trusted test target. There is no automatic fallback to an unsandboxed browser.

The isolated security smoke starts its own app process, checks credential
redaction on HTTP and WebSocket responses, verifies Chromium launch flags, and
loads the bundled font with external requests blocked. It needs a production
build and Chromium, but no blockchain node:

```sh
npm run build
npm run test:security
```

Inter is bundled from the exact, lockfile-pinned `@fontsource-variable/inter`
package and served from the app's origin. The font license is distributed at
`/fonts/OFL.txt`. The page does not fetch a stylesheet or font from a third party.

## Troubleshooting

- **Connection fails:** check the selected network and RPC URL, then use Apply
  configuration to retry initialization. Start the local node separately.
- **Funding fails:** the control panel shows the affected wallet and faucet error.
  Wait for any reported cooldown or restore faucet availability, then apply the
  configuration again. Existing funded wallets are reused.
- **Network mismatch:** verify the endpoint and `THRUPUT_NETWORK`. A Devnet
  reset may require updating the verified network ID in `server/network.ts`.
- **Fresh node:** restart the app so its cached wallet clients and chain tip are
  rebuilt. The deterministic addresses are funded again on the fresh chain.
- **Pending rises:** the outstanding-work limit applies backpressure. Release
  and let receipts drain; inspect Recent diagnostics before another run.
- **After prolonged use:** Apply configuration rechecks balances and tops up
  wallets below 1 HOG. Storage deposits are not transaction gas fees.

## Source map

- `server/chain.ts`: wallet provisioning and SDK transaction adapter.
- `server/network.ts`: Devnet/Localnet endpoints, identity pins, and SDK transport.
- `server/signer.ts`: deterministic development signer using Node crypto.
- `server/rpc.ts`: JSON-RPC batching and receipt validation.
- `server/engine.ts`: bounded pipeline, lease, lifecycle, and accounting.
- `server/index.ts`: same-origin HTTP/WebSocket application server.
- `server/commands.ts`: runtime validation of browser control messages.
- `shared/protocol.ts`: settings and telemetry types, with no browser SDK dependency.
- `src/main.ts`: pointer/keyboard input, settings, and live UI.
- `src/particles.ts`: bounded Canvas 2D renderer.
- `SPEC.md`: original specification and workstream.
