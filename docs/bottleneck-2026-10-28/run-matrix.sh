#!/usr/bin/env bash
# Two-source additivity test with two private test Workers: B alone, C alone, then both.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/test-results/bottleneck"
B=https://thruput-spray-pray-b.sdf-ecosystem.workers.dev
C=https://thruput-spray-pray-c.sdf-ecosystem.workers.dev
mkdir -p "$out/b" "$out/c"
others() { pgrep -fl "test-load.ts|receipt-latency.ts|test-browser.ts" | grep -v "$root" || true; }
guard() { o="$(others)"; if [ -n "$o" ]; then echo "ABORT: other load is running: $o"; kill "$watcher" 2>/dev/null; exit 3; fi; }
load() { # url seconds label cwd
  (cd "$4" && APP_URL="$1" LOAD_SECONDS="$2" LOAD_WALLETS=24 LOAD_ALLOW_ERRORS=1 \
    npx --prefix "$root" tsx "$root/scripts/test-load.ts" >"$out/$3.log" 2>&1
   echo "exit $?" >>"$out/$3.log"
   cp "$4/test-results/load-run.json" "$out/$3.json" 2>/dev/null)
}
(cd "$root" && WATCH_SECONDS=420 WATCH_OUTPUT="$out/blocks.json" npx tsx scripts/block-watch.ts >"$out/blocks.tsv" 2>"$out/blocks.err") &
watcher=$!
guard; echo "start $(date +%s) B-alone"; load "$B" 60 b-alone "$out/b"; sleep 30
guard; echo "start $(date +%s) C-alone"; load "$C" 60 c-alone "$out/c"; sleep 30
guard; echo "start $(date +%s) B+C"
load "$B" 120 bc-b "$out/b" & pb=$!
load "$C" 120 bc-c "$out/c" & pc=$!
wait $pb $pc
echo "end $(date +%s)"
wait $watcher
echo done
