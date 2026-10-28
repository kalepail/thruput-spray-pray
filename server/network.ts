import {
  futurenet,
  localnet,
  hashFromBase58,
  HttpTransport,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";

export interface NetworkEnv {
  THRUPUT_NETWORK?: string;
  THRUPUT_RPC_URL?: string;
  THRUPUT_NETWORK_HASH?: string;
}

export function networkConfig(env: NetworkEnv) {
  const network = env.THRUPUT_NETWORK ?? "localnet";
  if (network !== "futurenet" && network !== "localnet")
    throw new Error("THRUPUT_NETWORK must be futurenet or localnet");
  const rpcUrl =
    env.THRUPUT_RPC_URL ??
    (network === "futurenet"
      ? "https://rpc.thruput.network"
      : "http://127.0.0.1:9545");
  if (network === "futurenet" && !env.THRUPUT_NETWORK_HASH)
    throw new Error("THRUPUT_NETWORK_HASH is required for futurenet");
  const cluster =
    network === "futurenet"
      ? futurenet({
          rpcUrl,
          networkHash: networkHash(hashFromBase58(env.THRUPUT_NETWORK_HASH!)),
        })
      : localnet({ rpcUrl });
  return {
    rpcUrl,
    cluster,
    name: network === "futurenet" ? "Futurenet" : "Localnet",
  };
}
export type NetworkConfig = ReturnType<typeof networkConfig>;

export function networkTransport(rpcUrl: string) {
  return new HttpTransport(rpcUrl, {
    timeoutMs: 15_000,
    fetch: (input, init) => fetch(input, init),
  });
}
