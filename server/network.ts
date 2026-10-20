import { devnet, localnet, HttpTransport } from "@thruputchain/client";
import { networkHash, sha256Hash } from "@thruputchain/protocol";
import { hexBytes } from "./bytes.js";

export interface NetworkEnv {
  THRUPUT_NETWORK?: string;
  THRUPUT_RPC_URL?: string;
  THRUPUT_NETWORK_HASH?: string;
}

export function networkConfig(env: NetworkEnv) {
  const network = env.THRUPUT_NETWORK ?? "localnet";
  if (network !== "devnet" && network !== "localnet")
    throw new Error("THRUPUT_NETWORK must be devnet or localnet");
  const rpcUrl =
    env.THRUPUT_RPC_URL ??
    (network === "devnet"
      ? "https://rpc.thruput.network"
      : "http://127.0.0.1:9545");
  if (network === "devnet" && !env.THRUPUT_NETWORK_HASH)
    throw new Error("THRUPUT_NETWORK_HASH is required for devnet");
  const cluster =
    network === "devnet"
      ? devnet({
          rpcUrl,
          networkHash: networkHash(
            sha256Hash(hexBytes(env.THRUPUT_NETWORK_HASH!)),
          ),
        })
      : localnet({ rpcUrl });
  return {
    rpcUrl,
    cluster,
    name: network === "devnet" ? "Devnet" : "Localnet",
  };
}
export type NetworkConfig = ReturnType<typeof networkConfig>;

export function networkTransport(rpcUrl: string) {
  return new HttpTransport(rpcUrl, {
    timeoutMs: 15_000,
    fetch: (input, init) => fetch(input, init),
  });
}
