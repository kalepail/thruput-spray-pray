import { test } from "node:test";
import assert from "node:assert/strict";
import { ERC20 } from "@thruputchain/client/contracts";
import { thruputChain } from "../server/chain.js";
import { networkConfig } from "../server/network.js";

// 32 zero bytes in base58.
const ZERO = "1".repeat(32);

test("wallets share validated identity and cached calls still produce unique signed transactions", async (t) => {
  const methods: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      const result =
        request.method === "getVersionInfo"
          ? {
              wireFormat: "14.1.1",
              implementation: "test",
              supportedMethods: [
                "faucet_requestAirdrop",
                "getBalance",
                "getChainTip",
                "getNetworkInfo",
                "getVersionInfo",
              ],
            }
          : request.method === "getNetworkInfo"
            ? { networkHash: ZERO }
            : request.method === "getBalance"
              ? {
                  address: request.params.address,
                  rawBalance: "100000000",
                  stateBlockHeight: "1",
                }
              : request.method === "getChainTip"
                ? { blockHeight: "1", blockHash: ZERO }
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
    methods.filter((method) => method === "getNetworkInfo").length,
    1,
  );
  assert.equal(invocation.mock.callCount(), 4);
  assert.equal(new Set(operations.map((op) => op.hash)).size, 32);
  assert.equal(new Set(operations.map((op) => op.payload)).size, 32);
  assert.ok(operations.every((op) => op.receiver === (op.sender + 1) % 4));
});
