#!/usr/bin/env bash
# Deploy, then confirm that the coordinator and every lane run this exact version.
# Objects with running timers outlive a deploy until a newer caller resets them.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
profile="${CF_PROFILE:-default}"
url="${SPRAY_PRAY_URL:-https://thruput-spray-pray-worker.sdf-ecosystem.workers.dev}"

output="$(npx cf deploy --profile "$profile" 2>&1 | tee /dev/stderr)"
expected="$(printf '%s\n' "$output" | sed -n 's/.*Current Version ID: \([0-9a-f-]*\).*/\1/p' | tail -1)"
if [ -z "$expected" ]; then
  echo "Could not read the deployed version ID." >&2
  exit 1
fi

# Visiting /api/state restarts stale objects and reconfigures the lanes.
for _ in $(seq 1 60); do
  live="$(curl -fsS -m 30 "$url/api/state" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s),b=j.build??{};console.log([b.version,b.lanesOnVersion,b.lanes,j.phase].join(" "))}catch{console.log("")}})' ||
    true)"
  read -r version current total phase <<<"$live" || true
  if [ "${version:-}" = "$expected" ] && [ "${current:-}" = "${total:-x}" ] && [ "${phase:-}" = "ready" ]; then
    echo "Live: version $expected on the coordinator and $current of $total lanes; ready."
    exit 0
  fi
  sleep 5
done
echo "Timed out waiting for version $expected on every object (last: $live)." >&2
exit 1
