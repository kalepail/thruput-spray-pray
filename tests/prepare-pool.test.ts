import { test } from "node:test";
import assert from "node:assert/strict";
import { createPreparePool } from "../server/prepare-pool.js";

const request = {
  start: 0n,
  count: 1,
  walletCount: 4,
  tip: 1n,
  nonceBase: 0n,
};

test("a crashed worker rejects its job and leaves the pool", async (t) => {
  const pool = createPreparePool(
    2,
    {},
    { url: new URL("./fixtures/crash-worker.mjs", import.meta.url) },
  );
  t.after(() => pool.close());
  await assert.rejects(pool.prepare(request), /exited/);
  assert.equal(pool.live, 1);
  await assert.rejects(pool.prepare(request), /exited/);
  assert.equal(pool.live, 0);
  await assert.rejects(pool.prepare(request), /No preparation workers left/);
});

test("a silent worker times out instead of hanging", async (t) => {
  const pool = createPreparePool(
    1,
    {},
    {
      url: new URL("./fixtures/silent-worker.mjs", import.meta.url),
      jobTimeoutMs: 50,
    },
  );
  t.after(() => pool.close());
  await assert.rejects(pool.prepare(request), /timed out/);
});
