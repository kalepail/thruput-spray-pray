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

### Results

Not run yet. The first attempt on 2026-10-28 (00:11 local) was stopped after about 50 s of
A alone, because another agent was running a sweep on the public app. Run test 1 only when
no other load test is active on devnet.

## Next tests

1. Chain metrics during a 45k soak, from the devnet team: `scheduler_pending_tx_count`,
   `nomination_duration_seconds`, `block_period_seconds`,
   `scheduler_global_lock_hold_seconds`, `validation_duration_seconds`,
   `commit_duration_seconds`, and CPU for each thread.
2. Workload changes with one source: a lower declared gas than 100,000, a custom ERC20 in
   place of the native token, and unique receivers in place of the ring.
3. Receipts sampled at 1 in 1,000, to take read load off the indexer.
4. AWS senders in us-west-2, only if test 1 shows a sender limit.

## Commands

```bash
# Second source beside the public app.
SPRAY_WORKER_NAME=thruput-spray-pray-b SPRAY_WALLET_SEED=spray-and-pray/bottleneck-b/v1 \
SPRAY_PRAY_URL=https://thruput-spray-pray-b.sdf-ecosystem.workers.dev ./scripts/deploy.sh

# Block periods, beside any load.
WATCH_SECONDS=300 WATCH_OUTPUT=test-results/blocks.json npm run watch:blocks
```
