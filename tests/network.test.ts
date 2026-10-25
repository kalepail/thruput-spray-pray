import { test } from "node:test";
import assert from "node:assert/strict";
import { toBase58 } from "@thruputchain/client";
import { networkConfig, networkTransport } from "../server/network.js";

const HASH = "6RgqYi69r94rCG1qKZ5NfCMAxonNAMXbDsFZMgGwgP2J";

test("Explicit Devnet retains its endpoint and verified signing identity", () => {
  const config = networkConfig({
    THRUPUT_NETWORK: "devnet",
    THRUPUT_NETWORK_HASH: HASH,
  });
  assert.equal(config.rpcUrl, "https://rpc.thruput.network");
  assert.equal(config.name, "Devnet");
  assert.equal(config.cluster.rpcUrl, config.rpcUrl);
  assert.equal(toBase58(config.cluster.networkHash!), HASH);
  assert.deepEqual(config.cluster.capabilities, ["airdrop"]);
});

test("Devnet requires its identity because wipes change it", () => {
  assert.throws(
    () => networkConfig({ THRUPUT_NETWORK: "devnet" }),
    /THRUPUT_NETWORK_HASH/,
  );
});

test("Localnet is the default and retains its zero network identity", () => {
  const config = networkConfig({});
  assert.equal(config.name, "Localnet");
  assert.equal(config.rpcUrl, "http://127.0.0.1:9545");
  assert.equal(toBase58(config.cluster.networkHash!), "1".repeat(32));
});

test("RPC overrides retain the selected network pin", () => {
  const config = networkConfig({
    THRUPUT_NETWORK: "devnet",
    THRUPUT_NETWORK_HASH: HASH,
    THRUPUT_RPC_URL: "https://devnet-proxy.example",
  });
  assert.equal(config.cluster.rpcUrl, "https://devnet-proxy.example");
  assert.equal(config.name, "Devnet");
  assert.deepEqual(
    config.cluster.networkHash,
    networkConfig({ THRUPUT_NETWORK: "devnet", THRUPUT_NETWORK_HASH: HASH })
      .cluster.networkHash,
  );
  assert.throws(
    () => networkConfig({ THRUPUT_NETWORK: "mainnet" }),
    /devnet or localnet/,
  );
});

test("SDK transport resolves fetch at request time", async (t) => {
  const transport = networkTransport("https://rpc.thruput.network");
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      assert.equal(input, "https://rpc.thruput.network");
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      assert.equal(request.method, "getChainTip");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { height: 123 },
        }),
      );
    },
  );
  assert.deepEqual(await transport.request("getChainTip"), {
    height: 123,
  });
  assert.equal(calls, 1);
});
