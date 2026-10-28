# Max-TPS engine plan

Status: ramp done on 2026-10-27; devnet ceiling found (see below). The experiment branch
`test/8-wallets` is retired: its engine changes (runtime wallet count, back-off on backend
outages, one funding shard per wallet) are in this branch, and its wallet-count commits were
run settings only. Test Worker `thruput-spray-pray-8w` (seed `spray-and-pray/hosted-worker-8w/v1`, 32 funded wallets).

## Goal

Show the highest sustained transfer rate that devnet can confirm. A browser controls the
spray. The rate must not depend on the latency between the browser and the engine.

## Measured on 2026-10-27 (devnet 0.40.0, wire 14.1.1, 180 s runs, ERC20 ring)

| Wallets | Lanes | In flight | Batch x conc. | tx/s       | Tx per block | Receipt avg | Result                                    |
| ------- | ----- | --------- | ------------- | ---------- | ------------ | ----------- | ----------------------------------------- |
| 4       | 8     | 32,768    | 256 x 32      | 11,944     | 26,331       | 2.5 s       | clean                                     |
| 8       | 16    | 65,536    | 256 x 32      | 21,797     | 50,967       | 2.8 s       | clean                                     |
| 16      | 32    | 131,072   | 256 x 64      | 26,727     | 64,956       | 4.7 s       | clean, in-flight bound                    |
| 16      | 32    | 262,144   | 256 x 64      | **39,750** | 117,770      | 6.1 s       | clean, best result                        |
| 32      | 64    | 524,288   | 256 x 128     | 28,163     | 119,706      | 11.9 s      | 507,648 unresolved; devnet indexer failed |

Raw snapshots: `test-results/` and the session scratchpad (`baseline-4w.json`, `run-*.json`).

## Measured after the reset (2026-10-27 evening, devnet 0.41.0, wire 14.1.1)

The engine now backs off on `-32050`, and one shard funds each wallet. Devnet stayed healthy
through every run.

| Wallets | Lanes | In flight | Batch x conc. | Run   | tx/s       | Tx per block | Receipt avg | Result              |
| ------- | ----- | --------- | ------------- | ----- | ---------- | ------------ | ----------- | ------------------- |
| 16      | 32    | 262,144   | 256 x 64      | 60 s  | 44,095     | 122,591      | 5.2 s       | clean               |
| 24      | 48    | 393,216   | 256 x 96      | 60 s  | 46,760     | 136,815      | 7.4 s       | clean               |
| 32      | 64    | 524,288   | 256 x 128     | 60 s  | 45,119     | 146,189      | 9.5 s       | clean               |
| 24      | 48    | 393,216   | 256 x 96      | 180 s | **45,245** | 131,024      | 8.1 s       | clean, 8.39M ok     |
| 24      | 48    | 262,144   | 256 x 96      | 180 s | 36,338     | 102,688      | 6.7 s       | clean, 1,648 resent |

**Conclusion:** devnet sustains about 45k tx/s for ERC20 transfers. Past 24 wallets,
more load adds only receipt latency. A smaller in-flight cap lowers the rate but does not
make receipts much faster. The best showcase setting is 24 wallets, 48 lanes, and 393,216
in flight. The test Worker runs this setting now.

## What limits the rate

1. **Wallets.** Each sender may use 7,000 nonces per expiry height, and each block opens one
   height. The sustained cap is `wallets x 7,000` transfers per block. The 4-wallet app used
   94% of its cap. Rule: `wallets >= target_tps x block_seconds / 7,000`.
2. **In flight.** Little's law: `in_flight >= target_tps x receipt_seconds`. At 131,072 the
   lanes emptied each block and waited, so blocks alternated between 116k and 15k transfers.
3. **The indexer.** At 32 wallets, the chain still landed blocks of 155k-172k transfers. The
   indexer failed first: `-32050 backend unavailable: indexer not connected`, then
   `db_gateway not connected`. The engine polls one receipt for each transfer, so at 40k tx/s
   it adds about 40k indexer reads each second. This is the real ceiling of the current design.
4. **Signing CPU.** About 2.2k tx/s for each Durable Object. 64 lanes give about 140k tx/s,
   so CPU is not a limit yet.
5. **Block time** grows under load: 2.2 s at 12k tx/s, about 3.0 s at 40k tx/s.

## Design

The browser sends intent only: start, stop, and the pointer. The engine runs a closed loop
next to the RPC. Browser latency changes when the spray starts and stops, not its rate.

### Phase 0: before the next run

- Tell the devnet operators that the 32-wallet run took down the indexer. Ask for a test
  window and the indexer's safe read rate.
- Keep the public app on `main` (4 wallets) until the new engine is clean.

### Phase 1: changes to the current Workers engine

1. **Runtime wallet count.** Replace the `WALLET_COUNT` constant with `SPRAY_WALLETS`.
   Let one lane fund each wallet, and let the other lanes wait for the balance. This fixes the
   faucet race ("Funding observation stopped") at startup.
2. **Verify by balance, not by receipt.** Each sender sends 1 raw unit to its own sink
   address. One `getBalance` call for each sink in each block gives the exact count of
   successful transfers. This uses the state database, not the indexer, and costs
   `wallets` reads for each block in place of one read for each transfer.
3. **Sampled receipts.** Poll receipts for 1 transfer in 1,000. Use them for latency and
   spot checks. A slow audit after the run can check every hash.
4. **Adaptive in-flight cap.** Start at `wallets x 7,000 x 2`. Lower the cap when the receipt
   p50 goes above 6 s or a `retry` appears. Raise it when blocks alternate between large and
   small.
5. **Stop on backend errors.** On any `-32050`, stop sending and drain. Do not keep the load
   on a failing backend.
6. **Pre-signed reserve.** While idle, sign about 10 s of transfers for each lane. A click
   then sends at the full rate from the first batch. Throw away transfers when their expiry
   height gets too close. Expiries are 30-50 blocks ahead, so a reserve stays valid for about
   2 minutes.
7. **Per-block export.** Record the tx count, the block time, and the receipt p50 for each
   block. A chart of the blocks shows the true rate better than one average.

### Phase 2: native engine in AWS us-west-2 (only if Phase 1 shows a Cloudflare limit)

- A Rust engine with the same `/live` WebSocket protocol, so the browser does not change.
- `ed25519-dalek` signs about 50k transfers each second on each core. One 16-core host can
  sign more than the chain can take.
- The RPC is in us-west-2, so each round trip drops from 30-60 ms to about 1 ms. This cuts
  the in-flight transfers that each tx/s needs, not the chain limit.
- Expose it through Caddy or an ALB with TLS. The Worker can stay as the static site.

## Ramp plan for the next run

Run each step for 180 s. Go to the next step only when the current step is clean.

| Step | Wallets | In flight | Verify                     | Expected cap                       |
| ---- | ------- | --------- | -------------------------- | ---------------------------------- |
| 1    | 16      | 262,144   | balances + 1/1000 receipts | repeat 39.7k with low indexer load |
| 2    | 20      | 327,680   | same                       | ~46k                               |
| 3    | 24      | 393,216   | same                       | ~55k                               |
| 4    | 32      | 524,288   | same                       | chain limit                        |

Stop at once on any of these: `-32050`, a receipt p50 above 8 s, any unresolved
transfer, or block time above 5 s.

## Commands

```bash
# Deploy the test engine beside the public app (values for step 1).
SPRAY_WORKER_NAME=thruput-spray-pray-8w SPRAY_WALLET_SEED=spray-and-pray/hosted-worker-8w/v1 \
SPRAY_LANES=32 SPRAY_OUTSTANDING=262144 SPRAY_CONCURRENCY=64 \
SPRAY_PRAY_URL=https://thruput-spray-pray-8w.sdf-ecosystem.workers.dev ./scripts/deploy.sh

# Load test; LOAD_ALLOW_ERRORS logs recoverable lane errors but still fails on lost transfers.
APP_URL=https://thruput-spray-pray-8w.sdf-ecosystem.workers.dev LOAD_ALLOW_ERRORS=1 \
LOAD_SECONDS=180 LOAD_BATCH=256 LOAD_CONCURRENCY=64 npx tsx scripts/test-load.ts
```

`WALLET_COUNT` in `shared/protocol.ts` is 24 on this branch, the best setting.
