# Where the 45k tx/s ceiling comes from

Branch `test/bottleneck`. Started 2026-10-28.

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

Runner: `test-results/bottleneck/run-matrix.sh` (ignored folder; results copied below).

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

## Next tests

1. Chain metrics during a 45k soak, from the devnet team: `submit_unvetted_duration_seconds`,
   `ingestion_auth_rpc_seconds`, gateway CPU and connection errors, `scheduler_pending_tx_count`,
   `nomination_duration_seconds`, `block_period_seconds`,
   `scheduler_global_lock_hold_seconds`, `validation_duration_seconds`,
   `commit_duration_seconds`, and CPU for each thread.
2. Workload changes with one source: a lower declared gas than 100,000, a custom ERC20 in
   place of the native token, and unique receivers in place of the ring.
3. Receipts sampled at 1 in 1,000, to take read load off the indexer.
4. AWS senders in us-west-2: test 1 shows no sender limit, so skip this for throughput.

## Commands

```bash
# Second source beside the public app.
SPRAY_WORKER_NAME=thruput-spray-pray-b SPRAY_WALLET_SEED=spray-and-pray/bottleneck-b/v1 \
SPRAY_PRAY_URL=https://thruput-spray-pray-b.sdf-ecosystem.workers.dev ./scripts/deploy.sh

# Block periods, beside any load.
WATCH_SECONDS=300 WATCH_OUTPUT=test-results/blocks.json npm run watch:blocks
```
