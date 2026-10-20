# Published SDK integration: Spray & Pray

## Goal and baseline

Base: experiments main `6886e16`. Upgrade client 0.8.0 to published 0.10.0 while preserving the native signer, bounded submission and receipt pools, four-wallet ring, and batched JSON-RPC. No React migration is needed for this DOM/canvas application.

## Implementation phases

1. Install the published client and update the lockfile. Share one validated public client across signer-bound wallets and cache the four fixed transfer invocations. Keep nonce/expiry generation per transaction and yield between preparation batches.
2. Distinguish authoritative admission rejection from ambiguous RPC failures. Reject malformed envelopes, including responses with both result and error. Isolate receipt errors per row so one unavailable receipt does not hide valid peers; recognize the SDK's transaction-not-found code.
3. Add focused regressions for mixed batches, identity validation, response envelopes, and admission classification. Run typecheck, unit tests, formatting, build, and available local browser/load checks. Compare preparation performance only with controlled local infrastructure; no hosted faucet/load benchmark runs implicitly.
4. Review and commit this project before moving to Resonance. Record exact verification and limitations below.

## Acceptance

Submission slots never wait for commitment. Ambiguous acknowledgements retain the original signed hash. Successful receipt rows are consumed even when another row fails. The existing telemetry and outstanding-work limits remain authoritative. SDK helpers are adopted where they preserve batching rather than replacing one batch with hundreds of individual waiters.

## Verification record

Implemented with published client 0.10.0. Only `TxInvalid` and `TxRejected` remove submission evidence; other RPC errors remain observable. Mixed receipt batches retain valid peers and expose per-row failures. The live test also keeps unavailable rows pending.

- 24 unit tests passed, including mixed receipt results, exclusive response fields, ambiguous admission errors, one shared network validation, four cached invocations, and unique signed payloads across repeated preparation batches.
- Typecheck, formatting, and production build passed.
- A clean `npm ci --ignore-scripts` and the complete `npm run check` passed again. A project-scoped GitHub Actions workflow now runs those checks without accessing a live chain.
- Isolated CLI 0.18.0 / hog-devnode 0.1.27-rc.7 live test: 101/101 transfers confirmed with the exact recipient balance delta.
- Local browser journey: 79,744/79,744 transactions succeeded, zero failures/unresolved, measured 4,577 average confirmations/second in that run. This is a local observation, not a before/after speedup claim.
- Preparation profile: 16,384 signed transactions in 916 ms (17,893/second). No hosted network was used. Browser screenshots are in ignored `test-results/`; isolated node path was `/tmp/opencode/spray-local-eeO9fa`.
