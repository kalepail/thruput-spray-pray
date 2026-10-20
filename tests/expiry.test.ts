import { test } from "node:test";
import assert from "node:assert/strict";
import { expiryAllocator } from "../server/expiry.js";

test("each sender fills one height, then the next of its slot, never reusing one", () => {
  const expiry = expiryAllocator({
    ahead: 30n,
    window: 10n,
    perHeight: 3,
    slot: 1,
    slots: 2,
  });
  const used = new Map<bigint, number>();
  let tip = 100n;
  for (let i = 0; i < 60; i++) {
    if (i % 7 === 0) tip++;
    const height = expiry.next(0, tip);
    if (height === undefined) continue;
    assert.equal(height % 2n, 1n, "slot 1 of 2 uses odd heights");
    assert.ok(height >= tip + 30n);
    used.set(height, (used.get(height) ?? 0) + 1);
  }
  for (const count of used.values()) assert.ok(count <= 3);
  const heights = [...used.keys()];
  assert.deepEqual(
    heights,
    [...heights].sort((a, b) => (a < b ? -1 : 1)),
    "heights only move forward",
  );
});

test("a full window waits for new blocks; senders are independent", () => {
  const expiry = expiryAllocator({
    ahead: 10n,
    window: 2n,
    perHeight: 2,
    slot: 0,
    slots: 1,
  });
  // Heights 20, 21, and 22 hold two nonces each for sender 0.
  const first = Array.from({ length: 6 }, () => expiry.next(0, 10n));
  assert.deepEqual(first, [20n, 20n, 21n, 21n, 22n, 22n]);
  assert.equal(expiry.next(0, 10n), undefined);
  assert.equal(expiry.next(1, 10n), 20n, "another sender has its own cache");
  // One new block opens one more height.
  assert.equal(expiry.next(0, 11n), 23n);
  // A tip that passes the cursor restarts at the new floor.
  assert.equal(expiry.next(0, 40n), 50n);
});

test("a restarted shard resumes after the last height it used", () => {
  const stored = new Map<number, bigint>();
  const options = {
    ahead: 10n,
    window: 20n,
    perHeight: 2,
    slot: 0,
    slots: 1,
    resume: (sender: number) => stored.get(sender),
    onHeight: (sender: number, height: bigint) => stored.set(sender, height),
  };
  const before = expiryAllocator(options);
  assert.deepEqual(
    Array.from({ length: 5 }, () => before.next(0, 10n)),
    [20n, 20n, 21n, 21n, 22n],
  );
  // The new instance must not add to 22, which may already be full.
  const after = expiryAllocator(options);
  assert.equal(after.next(0, 10n), 23n);
  // A stored height below the new floor is simply skipped.
  assert.equal(after.next(0, 100n), 110n);
});
