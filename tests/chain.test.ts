import { test } from "node:test";
import assert from "node:assert/strict";
import { ERC20 } from "@thruputchain/client/contracts";
import { thruputChain } from "../server/chain.js";
import { networkConfig } from "../server/network.js";

test("wallets share validated identity and cached calls still produce unique signed transactions", async (t) => {
  const methods: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      const result =
        request.method === "groundhog_networkInfo"
          ? { networkHash: `0x${"00".repeat(32)}` }
          : request.method === "groundhog_getBalance"
            ? {
                address: request.params[0],
                rawBalance: "100000000",
                height: "1",
              }
            : request.method === "groundhog_chainTip"
              ? { height: "1", blockHash: `0x${"00".repeat(32)}` }
              : assert.fail(`Unexpected RPC: ${request.method}`);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      );
    },
  );
  const invocation = t.mock.method(ERC20.v0_1.transfer, "invocation");
  const chain = thruputChain(networkConfig({ THRUPUT_NETWORK: "localnet" }));
  await chain.setup(4, () => {});
  const operations = [
    ...(await chain.prepare(16, 4)),
    ...(await chain.prepare(16, 4)),
  ];
  assert.equal(
    methods.filter((method) => method === "groundhog_networkInfo").length,
    1,
  );
  assert.equal(invocation.mock.callCount(), 4);
  assert.equal(new Set(operations.map((op) => op.hash)).size, 32);
  assert.equal(new Set(operations.map((op) => op.payload)).size, 32);
  assert.ok(operations.every((op) => op.receiver === (op.sender + 1) % 4));
});
