# Verification record

> This record covers the Node server version of September 16, 2026. Current
> results for the Workers runtime are in `README.md` under **Verified results**.

## Environment

- Date: September 16, 2026.
- Node.js 22.23.1, npm 10.9.8.
- Groundhog CLI 0.17.5 from the local `groundhog-rpc` checkout.
- Local `hog-devnode` with protocol override `hogp/63c9284d8d5727e`.
- Interval block driver, 500 ms. RPC at `127.0.0.1:9545`.
- Client 0.8.0 and protocol 0.11.0 from GitHub Packages.
- Production frontend and compiled Node server, served at `127.0.0.1:5177`.
- Headless system Chromium, desktop 1440 × 960 and touch viewport 390 × 844.

## Checks completed

- Strict TypeScript check and production build.
- Engine tests: outstanding-work bound, successful drain, single-controller
  ownership, configuration lock while busy, unknown submission recovery,
  receipt timeout classification, heartbeat expiry, cancellation during signing,
  failure accounting, and duplicate-identity atomicity.
- RPC boundary tests: receipt identity, execution outcome, absent/malformed
  receipts, invalid coordinates and configuration.
- Signer test: deterministic identities, distinct wallet keys, native Ed25519
  verification against the returned public key.
- Live test: 101 committed transfers to an otherwise inactive recipient,
  with exactly +101 base units in its balance.
- Browser test: real mouse drag, exact particle-to-attempt count, successful
  receipts, stop on release, four-wallet configuration, keyboard input, blur,
  reload/disconnect, mobile layout, reduced motion, and actual touch events.
- Three ten-second sustained runs with 2, 16, and 64 wallets. All attempts
  resolved successfully.
- A twenty-second run with the maximum 128-wallet pool: all 109,184 attempts
  resolved successfully.
- Dependency audit after selecting patched Vite and WebSocket releases:
  zero reported vulnerabilities.

## Recorded measurements

| Run                            | Attempts = successes | Average receipt-observation TPS | Active work including drain |
| ------------------------------ | -------------------: | ------------------------------: | --------------------------: |
| 2 wallets                      |               59,904 |                           5,599 |              10.699 seconds |
| 16 wallets                     |               59,904 |                           5,563 |              10.769 seconds |
| 64 wallets                     |               60,416 |                           5,613 |              10.763 seconds |
| 128 wallets                    |              109,184 |                           5,274 |              20.701 seconds |
| Final browser drag, 16 wallets |               85,248 |                           5,090 |              16.748 seconds |

Settings: 128 transactions per batch, four submission requests, 8,192 maximum
outstanding transfers. All runs: zero failed, zero unresolved.

These runs reused the same local ledger and deterministic wallet pool. Funding
and configuration are outside the timer. Signing and receipt drain are inside
the timer. The browser run's duration includes input automation and screenshot
capture. No CPU isolation, repeated statistical sampling, or public consensus
measurement was performed.

The first implementation refilled its submission pipeline only on a 100 ms
telemetry tick and reached about 3,400 observed TPS in the browser. Review found
that artificial limit; the final implementation refills after submission with an
event-loop yield. The figures above measure that final scheduling path.

## Review findings addressed

1. Free HOG also reflects storage deposits and refunds from expired replay-cache
   entries. The live balance test now isolates
   an inactive recipient instead of treating a sender's free balance as a pure
   transfer ledger.
2. Dialog focus restoration initially raced keyboard input. Closing the drawer
   now clears inert state and restores focus synchronously.
3. Duplicate prepared hashes are validated for the whole batch before any
   accounting mutation, preventing an unpollable partial batch.
4. Malformed WebSocket origins are rejected without throwing out of the server's
   upgrade handler.
5. Ambiguous send responses retain their canonical hashes for polling. Timeouts
   remain unresolved, and reset/configuration cannot race outstanding work.

## Evidence and reproduction

Run the commands in `README.md` to regenerate:

- `test-results/load-runs.json`: full sustained-load snapshots.
- `test-results/load-runs-128.json`: twenty-second maximum-pool run.
- `test-results/browser-run.json`: browser run totals at release and after drain.
- `test-results/desktop-idle.png`, `desktop-spray.png`, `desktop-controls.png`.
- `test-results/mobile-canvas.png`, `mobile-controls.png`.

Evidence files are local and ignored. This record keeps the measured results
readable without committing runtime output or screenshots to the source tree.

## Follow-up: radial spray, block metrics, and throughput

On September 16, 2026, the user's running app was configured for 16 concurrent
requests and reported about 4,285 cumulative confirmed tx/s. The node invocation
used the default block driver, with no 500 ms interval override. The follow-up
used that node and separate engines; it preserved the user's app statistics.

Ten-second before/after checks, all with 16 wallets and batches of 128:

| Concurrent requests | Before: successful tx/s | After: successful tx/s | After: mean receipt delay |
| ------------------: | ----------------------: | ---------------------: | ------------------------: |
|                   4 |                   5,675 |                  6,778 |                    385 ms |
|                  16 |                   4,614 |                  5,673 |                  1,213 ms |

The four-request after-run committed 70,016 transfers in 617 distinct blocks.
Its average successful transfers per contributing block was 113.478. The
sixteen-request run committed 59,136 transfers in 586 blocks, averaging 100.915.
Both had zero failed or unresolved outcomes. A preparation-only CPU profile
signed 16,384 transactions in 908 ms (about 18,044/s), excluding submission and
receipt work. These are diagnostic samples, not a statistical chain benchmark.

Changes verified:

- Uniform full-circle emission, with directional bias and gravity removed.
- Independent receipt polling slots instead of round-wide barriers.
- Separate reservations for unsigned work, avoiding double-counting submissions.
- Flow-control messaging that distinguishes backpressure from transaction failure.
- Validated, canonical receipt heights, including decimal strings above the JS
  safe-integer range. Fractional, negative, malformed, and unsafe numeric heights
  are rejected.
- Block averaging deduplicates heights, handles out-of-order observations,
  excludes failed-only blocks, and clears on reset.
- A blocked receipt request cannot stall the other slots; concurrency stays at four.

`npm run check` passed all 13 tests, formatting, type checking, and the production
build. The live transfer check verified +101 base units at its inactive recipient.
The updated production browser was tested separately on port 5178, including
desktop, touch, lifecycle, the new block statistic, and particle/attempt counts.
Its main drag committed 115,200 transfers at 6,443 observed tx/s, with zero failed
or unresolved outcomes. Screenshots were visually reviewed for the radial spray
and new Control room layout.

## Fixed four-wallet demo

The wallet-count control was removed after the pool-size sweeps showed no
reliable throughput benefit in this experiment. The engine now provisions and
uses exactly four wallets. Wallet count is read-only telemetry; the configuration
schema accepts only batch size and request concurrency. Load tuning is collapsed
by default so the statistics remain the focus of Control room.

The updated checks passed 14 unit tests, type checking, formatting, the production
build, desktop/touch browser checks, and a sustained four-wallet run:

| Run                           | Successful transfers | Average observed TPS | Failed / unresolved |
| ----------------------------- | -------------------: | -------------------: | ------------------: |
| Browser drag, four wallets    |              120,448 |                6,657 |               0 / 0 |
| Ten-second load, four wallets |               66,944 |                6,490 |               0 / 0 |

The browser test also changed batch size and concurrency, verified that the
actual pool remained at four, and checked that the wallet slider was absent.
Earlier configurable-pool measurements above are historical; current
`test:load` writes one fixed-pool result to `test-results/load-run.json`.

## Devnet default

The default target is now `https://rpc.thruput.network`. Localnet remains
available through `GROUNDHOG_NETWORK=localnet`. Network selection is shared by
the app, live transfer test, and profiling scripts. RPC overrides retain the
selected network identity pin.

Verified remote identity and release:

- Network ID: `0xabb9cdbc56285d0e71c9845273ca06211fedf7ee2f58c43cfac6060f9402aa0f`.
- Gateway implementation: 0.17.5; wire format: 5.2.0.
- Reported release: 0.1.28-rc.5.

All four deterministic wallets were funded through the Devnet faucet. The
isolated live test committed 101 transfers and verified an exact +101 base-unit
recipient balance delta. Its first transaction was
`0x37979436bfbc35244a64ca5cf73fc42ee4b592d2e59b9e324e5cf9afbaa92434`.

The production browser journey ran on a separate local app port, using Devnet
for all transactions. Its passing main drag committed 9,472 transfers across
six contributing blocks, with zero failed and zero unresolved outcomes. It
observed 405 average successful tx/s over 23.382 seconds including receipt drain.
The complete journey, including keyboard, blur/reload, and touch input, finished
with 12,864 successful transfers. Browser JavaScript reported no errors.

Remote RPC timeouts were observed. The first longer run committed 17,152 of
17,280 attempts; a 128-transaction submission batch remained unresolved at the
deadline. The repeat browser journey passed, but a receipt-request timeout
extended its drain time before all outcomes resolved. These are not zero-RPC-
error measurements or Devnet capacity claims. The app retains those diagnostics
and does not turn missing responses into successful or failed transactions.

The installed client 0.8.0 still supplied an obsolete Devnet URL when called
without an override, so the application sets the stable HTTPS endpoint
explicitly. Its SDK transport uses a request-time fetch callback: the captured
bound default stalled HTTPS requests in this runtime, while the callback path
completed the same identity and funding requests. Unit coverage checks late
fetch resolution, endpoint defaults, network pins, and explicit Localnet mode.

`npm run check` passed all 18 tests, type checking, formatting, and the production
build. The UI now labels the selected network and describes experiment
throughput rather than claiming local-node measurements.
