# Spray & Pray on Workers

Hold, drag, and send a little chaos through Thruput, hosted on Cloudflare Workers and
Durable Objects with no container.

- URL: https://thruput-spray-pray-worker.sdf-ecosystem.workers.dev
- Account: Ecosystem - Stellar (`cf` profile `default`)
- Source: a fork of `groundhog-experiments/spray-pray` with the container session's
  throughput patches (`thruput-spray-pray-hosted/.work`, remote `hosted-work`).

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
- Each sender's replay-cache entries are spread across expiry heights in buckets of
  ~4,000 transfers. When one lane signs for one wallet, the bucket size must use that
  lane's sender count. Otherwise devnet excludes transfers with two-phase-commit storage
  conflicts (`retry`, executor code 3).
- The engine asks for the scheduler status of receipts overdue by
  `SPRAY_STATUS_AFTER_MS`. On `retry` or `unknown`, it resends the identical signed
  bytes. The hash does not change, so a resend never creates a second transfer.

## Deploy

```sh
GH_NPM_TOKEN="$(gh auth token)" npm ci
npm run check
npm run deploy        # cf deploy; no Docker
```

A deploy restarts objects that hold running timers. The Worker sends its version
timestamp with each request, and an older object resets itself.

## Settings

All settings are text bindings in `cloudflare.config.ts`.

| Binding                                 | Value                             | Purpose                                                      |
| --------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `THRUPUT_NETWORK_HASH`                  | devnet hash                       | Required for devnet; update after a wipe                     |
| `SPRAY_LANES`                           | `8`                               | Lane objects; a multiple of the four wallets                 |
| `SPRAY_WALLET_SEED`                     | `spray-and-pray/hosted-worker/v1` | Keeps these wallets apart from the container's               |
| `SPRAY_OUTSTANDING`                     | `32768`                           | Total in-flight transfers; devnet dropped transfers at ~49k+ |
| `SPRAY_BATCH_SIZE`, `SPRAY_CONCURRENCY` | `1000`, `16`                      | Starting UI settings; concurrency is divided between lanes   |
| `SPRAY_RPC_SOCKETS`                     | `12`                              | Keep-alive sockets per lane                                  |
| `SPRAY_PROBE_INTERVAL_MS`               | `200`                             | Poll one transfer per batch often, the rest after it lands   |
| `SPRAY_STATUS_AFTER_MS`                 | `6000`                            | Check scheduler status for receipts this late                |

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
curl -s https://thruput-spray-pray-worker.sdf-ecosystem.workers.dev/api/state
APP_URL=https://thruput-spray-pray-worker.sdf-ecosystem.workers.dev \
  LOAD_SECONDS=30 LOAD_BATCH=1000 LOAD_CONCURRENCY=16 npm run test:load
APP_URL=https://thruput-spray-pray-worker.sdf-ecosystem.workers.dev \
  CHROMIUM_PATH="<Chromium executable>" npm run test:browser
```

`/api/state` also lists each lane's data center and round trip to the RPC. Only one
deployment should spray devnet at a time.

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
