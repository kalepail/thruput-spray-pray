import { Session } from "node:inspector/promises";
import { thruputChain } from "../server/chain.js";
import { WALLET_COUNT } from "../shared/protocol.js";

// Prepare and sign only. No benchmark transfers are submitted.
const chain = thruputChain();
await chain.setup(WALLET_COUNT, () => {});
await chain.prepare(128, WALLET_COUNT);
const session = new Session();
session.connect();
try {
  await session.post("Profiler.enable");
  await session.post("Profiler.start");
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const count = 16_384;
  for (let i = 0; i < count; i += 128) await chain.prepare(128, WALLET_COUNT);
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const { profile } = await session.post("Profiler.stop");
  const functions = new Map<string, number>();
  for (const node of profile.nodes) {
    const name = `${node.callFrame.functionName || "(anonymous)"} (${node.callFrame.url.split("/").at(-1)})`;
    functions.set(name, (functions.get(name) ?? 0) + (node.hitCount ?? 0));
  }
  console.log(
    JSON.stringify(
      {
        prepared: count,
        elapsedMs: Math.round(elapsedMs),
        preparedPerSecond: Math.round((count * 1000) / elapsedMs),
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        hottestFunctions: [...functions]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12),
      },
      null,
      2,
    ),
  );
} finally {
  session.disconnect();
}
