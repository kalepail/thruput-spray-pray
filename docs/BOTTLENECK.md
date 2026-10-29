# Where the 45k tx/s ceiling comes from

Started 2026-10-28 on branch `test/bottleneck`, since merged.

## Question

Devnet holds at about 45k tx/s for ERC20 transfers. The devnet team reports that the
validators use only about half of their CPU. Is the limit in the senders (Workers, the
Cloudflare-to-AWS path, the single gateway) or in the chain? If the senders are the limit,
more parallel servers raise the rate. If the chain is the limit, they do not.

## What the earlier runs show

| Wallets | Lanes | tx/s   | Tx per block | Block period |
| ------- | ----- | ------ | ------------ | ------------ |
| 16      | 32    | 44,095 | 122,591      | 2.78 s       |
| 24      | 48    | 46,760 | 136,815      | 2.93 s       |
| 32      | 64    | 45,119 | 146,189      | 3.24 s       |

Twice the senders put more transfers in each block, but each block took longer. The rate
did not change. This points at the chain, but all runs used one sender setup.

Facts from the node source and devnet (read-only):

- One validator (`3nqt6kZh…`) proposed every sampled block. It runs all execution.
- Each proposal holds `scheduler_->global_lock_` across 25 serial `schedule()` chunks
  (`hogd/hog_mempool/rpc_from_coord.cc`).
- One DB shard serves all state. Sharding is still in review (roadmap).
- `rpc.thruput.network` resolves to one IP.

A serial step like these can stop throughput while the host uses only half of its cores.

## Test 1: two independent sources

Source A is the public app. Source B is the test Worker `thruput-spray-pray-b` with seed
`spray-and-pray/bottleneck-b/v1`. Each has 24 wallets, 48 lanes, and 393,216 in flight.
They share no wallets, so the per-sender nonce cap does not join them.

Run A alone, then B alone, then both at once. `scripts/block-watch.ts` records each block
period for the whole time.

- If A+B is clearly above one source alone, the senders are the limit.
- If A+B stays near 45k and the two share it, the chain is the limit.

Runner and raw results: `docs/bottleneck-2026-10-28/` (`run-matrix.sh`).

### Results (2026-10-28, devnet 0.41.0)

The public app was busy with other work, so the run used two private test Workers:
B (`thruput-spray-pray-b`, seed `spray-and-pray/bottleneck-b/v1`) and C
(`thruput-spray-pray-c`, seed `spray-and-pray/bottleneck-c/v1`). Devnet was idle before the
start (2.03 s blocks). Rates are successful transfers divided by elapsed run time.

| Run           | Succeeded | tx/s       | Tx per block | Block period | Receipt avg | Unresolved |
| ------------- | --------- | ---------- | ------------ | ------------ | ----------- | ---------- |
| B alone, 60 s | 2,788,992 | 41,552     | 126,772      | 2.83 s       | 7.8 s       | 0          |
| C alone, 60 s | 2,818,560 | 42,887     | 128,116      | 2.88 s       | 7.5 s       | 0          |
| B + C, 120 s  | 5,141,595 | **36,250** | ~51k each    | 2.65 s       | 18.4-18.8 s | 293        |

During B + C, B resent 8,898 transfers and C resent 1,053. Both logged
`Network connection lost.` and `Submission response was ambiguous`. 238 (B) and 55 (C)
transfers stayed unresolved at the receipt deadline, so `test-load.ts` failed its check.

**Conclusion:** the senders are not the limit. Two sources gave less in total than one
source alone, and the receipts became more than twice as slow. More parallel servers will
not raise the rate.

The blocks also got shorter (2.65 s against 2.83-2.88 s) and carried fewer transfers. So
during the combined run the chain received transfers more slowly. It did not execute
bigger blocks. This points at the path into the chain (the one gateway, admission, and
signature checks) more than at block execution. The node metrics in "Next tests" can
confirm this.

## Test 2: transaction cost and declared gas

Each transaction is `DefaultWallet.execute` on the sender's account (root gas limit
500,000) with one call to the native token's `ERC20.transfer` (gas limit 100,000). It
signs to 316 bytes. Scheduling reserves one native-token base unit per unit of declared
root gas, not gas used, so each transfer reserves 0.05 HOG of a wallet's ~1,000 HOG while
it waits.

`simulateInvocation` on devnet 0.41.0 (read-only):

| Root call                                  | Gas used | Signed bytes |
| ------------------------------------------ | -------- | ------------ |
| `execute` with one transfer (what we send) | 38,051   | 316          |
| `execute` with one `totalSupply` read      | 37,701   | ~300         |
| `execute` with 16 transfers                | 47,816   | 1,484        |

About 37,700 gas is a fixed cost of any call into a native contract; a transfer adds only
about 350 gas. No other call is materially cheaper, so the workload is already as light as
one transaction can be. Batching 16 transfers into one `execute` would raise transfers per
second, not transactions per second, so the app keeps one transfer per transaction.

A/B of the declared gas, test Worker `thruput-spray-pray-gas` (seed
`spray-and-pray/bottleneck-b/v1`, since deleted), 24 wallets, 48 lanes, 393,216 in flight,
60 s each, run in the order below:

| Run | Root / transfer gas | Steady tx/s | Block period | Failed / unresolved |
| --- | ------------------- | ----------- | ------------ | ------------------- |
| A1  | 500,000 / 100,000   | 41,748      | 2.86 s       | 0 / 0               |
| B1  | 50,000 / 45,000     | 45,057      | 2.87 s       | 0 / 0               |
| A2  | 500,000 / 100,000   | 45,035      | 2.81 s       | 0 / 0               |
| B2  | 50,000 / 45,000     | 45,033      | 2.78 s       | 0 / 0               |

A1 was the first run after a deploy. **Conclusion:** the declared gas does not limit tx/s.
50,000 / 45,000 is safe if a lower reservation is ever wanted, but it gains nothing now.

## Test 3: receipt lookups sampled 1 in 1,000

Each lane looks up the receipt of every transfer, about 45k lookups a second at full
rate. To see whether that read load slows the chain, `SPRAY_RECEIPT_SAMPLE=N` looks up 1
in N transfers. The others settle when their batch's probe lands, and are looked up only
if the probe fails. `assumed` counts transfers settled without a lookup.

Test Worker `thruput-spray-pray-sample` (seed `spray-and-pray/receipt-sample/v1`, since
deleted), 24 wallets, 48 lanes, 393,216 in flight, 120 s each. Run A stopped spraying
after about 68 s, so A2 repeats it.

| Run | Lookups        | Succeeded | Assumed   | tx/s   | Busy block period | Receipt avg | Failed / unresolved |
| --- | -------------- | --------- | --------- | ------ | ----------------- | ----------- | ------------------- |
| A   | every transfer | 2,456,832 | 0         | 36,354 | 2.87 s            | 9.9 s       | 0 / 0               |
| B   | 1 in 1,000     | 4,493,056 | 4,471,082 | 35,340 | 3.02 s            | 10.5 s      | 0 / 0               |
| A2  | every transfer | 4,783,616 | 0         | 37,590 | 2.99 s            | 9.8 s       | 0 / 0               |

**Conclusion:** receipt polling does not limit tx/s. B removed 99.5% of the lookups, and
the rate, block period, and receipt time did not improve. In B, 5,212 submissions had an
ambiguous response and then settled from their probe without their own lookup, so the
hosted app keeps `SPRAY_RECEIPT_SAMPLE=1`. A firehose or faster indexer would shorten the
receipt lag. It would probably not raise tx/s much: both runs sat at the in-flight cap, but
524,288 in flight, which covers more receipt lag, measured about 42k tx/s.

## Test 4: lane placement beside the RPC (2026-10-29, Futurenet)

The hosted app had the coordinator and 33 of 48 lanes in DFW, about 57 ms from the RPC
in AWS us-west-2. Placement probed only 64 fixed candidates, and a `wnam` hint lands
mostly in DFW, so it kept most of them. Arm B probes up to 512 candidates
(`lanes-v2`, `coordinator-v2`) and got 34 lanes in SEA and 14 in SJC (median 10 ms), with
the coordinator in SEA (9 ms).

Hosted app, 24 wallets, 48 lanes, batch 256, concurrency 96, 393,216 in flight, 60 s per
run, order A A B B A B. Sends/s is succeeded / 60 s; every run had 0 failed and 0
unresolved.

| Run | Lanes (median RTT)                         | Succeeded | Sends/s | Average tx/s | Receipt avg |
| --- | ------------------------------------------ | --------- | ------- | ------------ | ----------- |
| A1  | 33 DFW, 8 SJC, 3 DEN, 2 SEA, 2 LAX (58 ms) | 2,040,832 | 34,014  | 29,297       | 12.0 s      |
| A2  | same                                       | 2,269,184 | 37,820  | 31,613       | 11.1 s      |
| B1  | 34 SEA, 14 SJC (10 ms)                     | 2,342,144 | 39,036  | 34,642       | 10.5 s      |
| B2  | same                                       | 2,591,744 | 43,196  | 35,471       | 9.5 s       |
| A3  | as A1 (56 ms)                              | 2,192,384 | 36,540  | 30,531       | 11.3 s      |
| B3  | as B1 (10 ms)                              | 2,295,040 | 38,251  | 34,008       | 10.7 s      |

**Conclusion:** placement beside the RPC is better in every run: sends/s 40,161 against
36,124 (+11%), average tx/s +13%, and receipts 10.2 s against 11.5 s. The ranges do not
overlap. The hosted app now runs arm B.

The first deploy of arm B found a second problem. The Placement object outlived the
deploy, so it kept handing out the old keys: 11 of 16 requests reached the old
coordinator and lanes, and the rest reached the new ones, two experiments on the same
wallets. Placement now restarts when a caller runs a newer version, like the lanes and
the coordinator; after that fix every request reached one coordinator on each switch.

## Upstream benchmark for comparison

`groundhogchain/metrics_history` stores hogd CI benchmarks. On 2026-10-28 (hogd `7f471b9f6`), `schedgateway_stress_batches` submitted
1,944,400 native-token transfers in 10 s, about 194k tx/s, straight to the scheduler. That
run used 8 connections, batches of 100, 1,000 accounts, and 500 ms blocks. One connection
with one call in flight (`schedgateway_submit_c1`) gave about 3.4k tx/s at 279 us p50.

Devnet stops at about 45k tx/s through the public JSON-RPC gateway. The scheduler alone
takes about 4x more in CI. So the gap is most likely in the public gateway, in the devnet
host setup, or in how few accounts we use (24 or 48, against 1,000). The two-source test
used 48 accounts and got a lower rate, so account count alone does not explain the gap.

## Next tests

1. Chain metrics during a 45k soak, from the devnet team: `submit_unvetted_duration_seconds`,
   `ingestion_auth_rpc_seconds`, gateway CPU and connection errors, `scheduler_pending_tx_count`,
   `nomination_duration_seconds`, `block_period_seconds`,
   `scheduler_global_lock_hold_seconds`, `validation_duration_seconds`,
   `commit_duration_seconds`, and CPU for each thread.
2. Workload changes with one source: a custom ERC20 in place of the native token, and
   unique receivers in place of the ring. (Lower declared gas: done, no change; see Test 2.)
3. Receipts sampled at 1 in 1,000: done, no change; see Test 3.
4. Ask the devnet team how the public gateway (`thruput-tools`) submits to the scheduler:
   one transfer per call or batches, and how many connections.
5. AWS senders in us-west-2: test 1 shows no sender limit, so skip this for throughput.

## Commands

```bash
# Second source beside the public app.
SPRAY_WORKER_NAME=thruput-spray-pray-b SPRAY_WALLET_SEED=spray-and-pray/bottleneck-b/v1 \
SPRAY_PRAY_URL=https://thruput-spray-pray-b.sdf-ecosystem.workers.dev ./scripts/deploy.sh

# Block periods, beside any load.
WATCH_SECONDS=300 WATCH_OUTPUT=test-results/blocks.json npm run watch:blocks
```
