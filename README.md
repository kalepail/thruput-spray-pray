# Spray & Pray on Workers

Hold, drag, and send a little chaos through Thruput, hosted on Cloudflare Workers and
Durable Objects with no container.

- URL: https://thruput-spray-pray.sdf-ecosystem.workers.dev
- Account: Ecosystem - Stellar (`cf` profile `default`)
- Source: upstream `groundhog-experiments/spray-pray` plus all the throughput work
  from the former container deployment (merged from its patch workspace, `c7b836e`),
  rebuilt for Workers. The upstream checkout is pull-only, so this repository carries
  the changes; `git diff 810c856` shows the full delta from upstream.

The browser UI is unchanged. Every transfer is a real `ERC20.transfer` of one base unit
of HOG between four demo wallets on devnet.

## Architecture

```
browser ──WebSocket──▶ Worker ──▶ SprayPray (coordinator, 1 object)
                                     │  lease, WebSockets, merged statistics
                                     ├──RPC every 100 ms──▶ SprayLane × 8 (SEA/SJC)
                                     │                        sign · submit · poll
                                     └──▶ Placement (1 object): picks the lanes
```

- **SprayLane** runs the upstream `Engine` for one sender wallet. Two lanes share each of
  the four wallets. Each lane signs on its own isolate and core, and each has its own
  connections, so throughput scales with the lane count (`SPRAY_LANES`).
- **SprayPray** holds the browser WebSockets and the single spray lease. It forwards
  heartbeats to the lanes and merges their reports into one `Snapshot`.
- **Placement** chooses lane objects once and stores their names. Durable Objects do not
  move after creation, and a `wnam` hint lands anywhere in Western North America.
  Placement creates candidates until it finds lanes beside the RPC in AWS us-west-2.

### Why it is built this way

These were measured on 2026-10-20 against devnet, with no other load:

| Design                            | Result                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| One Durable Object, placed in DFW | 1,200–2,200 tx/s; 160 KB batch uploads to us-west-2 are slow from distant data centers |
| One Durable Object in SEA         | 2,200–2,900 tx/s; one isolate is CPU-bound                                             |
| 4 lanes in SEA                    | 6,800–7,900 tx/s; each lane CPU-bound at ~2,000 tx/s                                   |
| 8 lanes in SEA/SJC                | 10,400–12,200 tx/s; in-flight work at the 32,768 cap, so devnet is the limit           |

Other findings that shaped the code:

- A Worker invocation can have only six `fetch()` calls waiting for response headers,
  and the RPC answers only after it processes a whole batch. `server/socket-rpc.ts`
  keeps a pool of HTTP/1.1 keep-alive TLS sockets instead. Sockets count toward that
  limit only while they open.
- Placement hints for Workers (`placement.region`) do not apply to service-binding or
  Durable Object calls, so a placed egress Worker did not help.
- Web Crypto Ed25519 produces byte-identical transactions to the Node signer and signs
  faster in workerd.
- A sender's replay cache takes at most 8,000 unexpired nonces per expiry height
  (`kReplayCacheNoncesMaxLen` in `protocol/storage_item.x`). Upstream's counter-based
  buckets wrap after about 2 minutes of sustained load and overfill heights, which
  devnet reports as `retry` (executor code 3, a capacity conflict) that resends cannot
  fix. `server/expiry.ts` fills one height per sender up to 7,000, moves forward, never
  reuses a height, and waits for new blocks when its window is full. Lanes persist the
  cursor, so a restart continues past heights it already filled. Sustained throughput
  is therefore bounded by about 7,000 transfers per wallet per block.
- Lanes that share a wallet take alternate expiry heights.
- Lanes push each submitted batch to the coordinator, which draws it at once at the
  pointer: one 256-particle burst per batch, so a drag leaves a trail as upstream did.
- The headline confirmed rate is block-based: transfers in the last three completed
  blocks divided by their interval. Receipts arrive in 25,000–40,000-transfer lumps
  every ~2.5 s, so any short time window swings with block timing. Before two blocks
  land it shows the average since the spray began; after work ends, a trailing window
  decays to zero.
- Every coordinator call to a lane has a deadline, and browser heartbeats are
  forwarded without waiting. One WebSocket's messages are handled in order, so a lane
  call that never returned once held back heartbeats for 7 minutes.
- The engine asks for the scheduler status of receipts overdue by
  `SPRAY_STATUS_AFTER_MS`. On `retry` or `unknown`, it resends the identical signed
  bytes. The hash does not change, so a resend never creates a second transfer.

## Deploy

```sh
GH_NPM_TOKEN="$(gh auth token)" npm ci
npm run check
npm run deploy        # scripts/deploy.sh; no Docker
```

A deploy restarts objects that hold running timers. The Worker sends its version
timestamp with each request, and an older object resets itself. `scripts/deploy.sh`
runs `cf deploy`, then polls `/api/state` until `build.version` equals the new version
ID, every lane reports it, and the phase is `ready`. It exits non-zero after about
5 minutes otherwise.

## Settings

All settings are text bindings in `cloudflare.config.ts`.

| Binding                                 | Value                             | Purpose                                                      |
| --------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `THRUPUT_NETWORK_HASH`                  | devnet hash                       | Required for devnet; update after a wipe                     |
| `SPRAY_LANES`                           | `8`                               | Lane objects; a multiple of the four wallets                 |
| `SPRAY_WALLET_SEED`                     | `spray-and-pray/hosted-worker/v1` | Keeps these wallets apart from the container's               |
| `SPRAY_OUTSTANDING`                     | `32768`                           | Total in-flight transfers; devnet dropped transfers at ~49k+ |
| `SPRAY_BATCH_SIZE`, `SPRAY_CONCURRENCY` | `256`, `32`                       | Starting UI settings; concurrency is divided between lanes   |
| `SPRAY_RPC_SOCKETS`                     | `12`                              | Keep-alive sockets per lane                                  |
| `SPRAY_PROBE_INTERVAL_MS`               | `200`                             | Poll one transfer per batch often, the rest after it lands   |
| `SPRAY_FIRST_POLL_RATIO`                | `0.8`                             | First poll near the average receipt delay; fewer lookups     |
| `SPRAY_POLL_CONCURRENCY`, `_BATCH`      | `8`, `1000`                       | Receipt lookups per lane; RPC arrays take up to 1,000        |
| `SPRAY_SUBMIT_RETRIES`                  | `2`                               | Resend identical bytes only after a lost connection          |
| `SPRAY_STATUS_AFTER_MS`                 | `6000`                            | Check scheduler status for receipts this late                |
| `SPRAY_EXPIRY_AHEAD`, `_WINDOW`         | `30`, `20`                        | First expiry 30 blocks ahead; 20 heights before waiting      |
| `SPRAY_NONCES_PER_HEIGHT`               | `7000`                            | Per sender per height; the protocol limit is 8,000           |

Engine limits are validated: integers, at least 1 where 0 would stall the engine, and
a first-poll ratio between 0 and 2. Resends never follow an HTTP status. Devnet answers
a duplicate of an admitted transfer with the same hash, so a rejection after a resend
counts as Failed.

Do not raise `SPRAY_OUTSTANDING` above 32768 without a clean re-measurement. At
49152 and above, many accepted transfers reported `retry` (two-phase-commit storage
conflicts) instead of committing, and 32768 already saturates devnet.

## After a devnet wipe

`/api/state` reports `Network mismatch`. Read the new hash, put it in
`THRUPUT_NETWORK_HASH`, and deploy:

```sh
curl -s -X POST https://rpc.thruput.network -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"groundhog_networkInfo","params":[]}'
```

The lanes fund the four wallets from the faucet on their next start.

## Verify

```sh
curl -s https://thruput-spray-pray.sdf-ecosystem.workers.dev/api/state
APP_URL=https://thruput-spray-pray.sdf-ecosystem.workers.dev \
  LOAD_SECONDS=30 LOAD_BATCH=1000 LOAD_CONCURRENCY=16 npm run test:load
APP_URL=https://thruput-spray-pray.sdf-ecosystem.workers.dev \
  CHROMIUM_PATH="<Chromium executable>" npm run test:browser
```

`/api/state` also lists each lane's data center and round trip to the RPC, and the
`build` stamp. `npm run test:security` checks the deployed app without spraying.
`test:browser` restores the app's starting settings when it finishes. `test:lease`
checks that a second browser is refused and that the lease passes on release and on
disconnect. `test:load` fails if its WebSocket closes mid-run.

The load and browser tests send real transfers to shared devnet. Agree a window with
anyone else load-testing devnet first, and keep only one sprayer running.

## History

Measured on 2026-10-20 (devnet 0.29.2, wire 11.2.0). Successful tx/s includes the
drain after release; failed and unresolved were 0 in every row.

| Configuration                                              | tx/s          |
| ---------------------------------------------------------- | ------------- |
| Upstream app in a `standard-2` container, 128 / 4          | 1,917         |
| Tuned container, `standard-4`, 4 signing threads, 256 / 32 | 10,865–12,743 |
| Tuned container, clean devnet, 30 s ×2                     | 9,405 / 9,817 |
| Workers, 8 lanes, clean devnet, 1000 / 16, 30 s ×4         | 10,637–12,340 |

The container limits were, in order: the 8,192 in-flight cap, receipt polling, then
signing CPU. While spraying, devnet blocks carry 25,000–41,000 transfers and stretch
from 2.0 s to 2.2–3.3 s, so devnet itself is near saturation. Shared-devnet load
varies from run to run.

## Cost

Rates from the Cloudflare pricing pages on 2026-10-20, per hour while active:

|          | Container `standard-4`                           | This Worker                                                   |
| -------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Memory   | 12 GiB provisioned: ~$0.11                       | 9 objects × 128 MB: ~$0.05                                    |
| CPU      | Active vCPU-seconds, up to ~$0.29 while spraying | Not billed for Durable Objects                                |
| Requests | —                                                | Lane reports: up to ~$0.04 while spraying, 10× less when idle |

The coordinator stops after 30 idle minutes, and lanes stop 2 minutes after their last
report. Statistics reset when objects restart.

## Source map

- `worker/index.ts`: Worker entry, static assets, routing to the coordinator.
- `worker/coordinator.ts`: `SprayPray` — lease, WebSockets, merged statistics.
- `worker/lane.ts`: `SprayLane` — one engine per sender wallet.
- `worker/placement.ts`: `Placement` — chooses lanes beside the RPC.
- `server/engine.ts`: bounded pipeline, probe polling, scheduler retry handling.
- `server/chain.ts`, `server/prepare.ts`: wallets, sender shards, signing.
- `server/signer.ts`: Web Crypto Ed25519 demo signer.
- `server/socket-rpc.ts`: keep-alive JSON-RPC socket pool.
- `src/`, `index.html`: the unchanged upstream browser UI.
