import { test } from "node:test";
import assert from "node:assert/strict";
import {
  receiptOutcome,
  receiptResults,
  submissionOutcome,
  rpcBatch,
} from "../server/rpc.js";
import { ThruputRpcErrorCode } from "@thruputchain/client";
import { commandSchema } from "../server/commands.js";
import { demoSigner } from "../server/signer.js";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify,
} from "node:crypto";

test("only authoritative admission errors discard a signed hash", () => {
  const row = { jsonrpc: "2.0" as const, id: 0 };
  for (const code of [
    ThruputRpcErrorCode.TxInvalid,
    ThruputRpcErrorCode.TxRejected,
  ])
    assert.equal(
      submissionOutcome("hash", {
        ...row,
        error: { code, message: "rejected" },
      }),
      "rejected",
    );
  for (const code of [
    ThruputRpcErrorCode.BackendTimeout,
    ThruputRpcErrorCode.Overloaded,
    -32603,
  ])
    assert.equal(
      submissionOutcome("hash", {
        ...row,
        error: { code, message: "uncertain" },
      }),
      "unknown",
    );
  assert.equal(
    submissionOutcome("hash", { ...row, result: "hash" }),
    "accepted",
  );
  assert.equal(
    submissionOutcome("hash", { ...row, result: "different" }),
    "unknown",
  );
});

test("mixed receipt batches retain valid peers and defer not-found receipts", () => {
  const row = { jsonrpc: "2.0" as const, id: 0 };
  const results = receiptResults(
    ["a", "b", "c", "d"],
    [
      {
        ...row,
        result: { txHash: "a", height: "12", status: { result: "ok" } },
      },
      {
        ...row,
        error: {
          code: ThruputRpcErrorCode.TxNotFound,
          message: "Not yet indexed",
        },
      },
      {
        ...row,
        result: { txHash: "wrong", height: "12", status: { result: "ok" } },
      },
      {
        ...row,
        result: { txHash: "d", height: "13", status: { result: "reverted" } },
      },
    ],
  );
  assert.deepEqual(results, [
    { state: "succeeded", height: "12" },
    undefined,
    { state: "unavailable", message: "Receipt hash mismatch" },
    { state: "failed", height: "13" },
  ]);
});

test("batch envelopes require exactly one result or error", async (t) => {
  let reply: unknown;
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(reply)),
  );
  for (const fields of [
    {},
    { result: null, error: { code: -1, message: "ambiguous" } },
  ]) {
    reply = [{ jsonrpc: "2.0", id: 0, ...fields }];
    await assert.rejects(
      rpcBatch("http://localhost", "method", [[]]),
      /exactly one/,
    );
  }
  reply = [
    { jsonrpc: "2.0", id: 1, result: "b" },
    { jsonrpc: "2.0", id: 0, result: "a" },
  ];
  assert.deepEqual(
    (await rpcBatch("http://localhost", "method", [[], []])).map(
      (r) => r.result,
    ),
    ["a", "b"],
  );
});

test("receipts validate identity and execution, not just presence", () => {
  const response = {
    jsonrpc: "2.0" as const,
    id: 0,
    result: { txHash: "a", height: "2", status: { result: "ok" } },
  };
  assert.deepEqual(receiptOutcome("a", response), {
    state: "succeeded",
    height: "2",
  });
  assert.throws(() => receiptOutcome("b", response), /mismatch/);
  assert.equal(receiptOutcome("a", { ...response, result: null }), undefined);
  assert.throws(() => receiptOutcome("a", { ...response, result: {} }));
  assert.deepEqual(
    receiptOutcome("a", {
      ...response,
      result: { ...response.result, height: "9007199254740993" },
    }),
    { state: "succeeded", height: "9007199254740993" },
  );
  for (const height of [
    2,
    "0002",
    "9223372036854775808",
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "no-height",
  ]) {
    assert.throws(() =>
      receiptOutcome("a", {
        ...response,
        result: { ...response.result, height },
      }),
    );
  }
  assert.throws(
    () =>
      receiptOutcome("a", {
        ...response,
        error: { code: -1, message: "unavailable" },
      }),
    /unavailable/,
  );
});
test("input boundary rejects invalid settings and coordinates", () => {
  for (const concurrency of [0, 33, 2.5])
    assert.equal(
      commandSchema.safeParse({
        type: "configure",
        settings: { batchSize: 4, concurrency },
      }).success,
      false,
    );
  assert.equal(
    commandSchema.safeParse({
      type: "configure",
      settings: { wallets: 16, batchSize: 128, concurrency: 4 },
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ type: "spray", point: { x: -1, y: 0 } }).success,
    false,
  );
});
test("Web Crypto signer is deterministic, keeps the Node-derived keys, and signs validly", async () => {
  const signer = await demoSigner(0);
  assert.deepEqual(signer.publicKey, (await demoSigner(0)).publicKey);
  assert.notDeepEqual(signer.publicKey, (await demoSigner(1)).publicKey);
  assert.ok("ed25519" in signer.publicKey);
  // The original Node signer derived the same seed; funded wallets must not change.
  const seed = createHash("sha256")
    .update("spray-and-pray/local-demo/v1/0")
    .digest();
  const nodeKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  assert.deepEqual(
    Buffer.from(signer.publicKey.ed25519),
    createPublicKey(nodeKey).export({ format: "der", type: "spki" }).subarray(-32),
  );
  const message = new TextEncoder().encode("spray");
  const signature = await signer.sign(message);
  assert.ok("ed25519" in signature);
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      signer.publicKey.ed25519,
    ]),
    type: "spki",
    format: "der",
  });
  assert.ok(verify(null, message, key, signature.ed25519));
});
