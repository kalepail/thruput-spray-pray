import { devnet, localnet, HttpTransport } from "@thruputchain/client";
import { networkHash, sha256Hash } from "@thruputchain/protocol";

export function networkConfig(env: NodeJS.ProcessEnv = process.env) {
  const network = env.THRUPUT_NETWORK ?? "localnet";
  if (network !== "devnet" && network !== "localnet") {
    throw new Error("THRUPUT_NETWORK must be devnet or localnet");
  }
  const rpcUrl =
    env.THRUPUT_RPC_URL ??
    (network === "devnet"
      ? "https://rpc.thruput.network"
      : "http://127.0.0.1:9545");
  const cluster =
    network === "devnet"
      ? devnet({
          rpcUrl,
          networkHash: networkHash(
            sha256Hash(
              Buffer.from(
                (
                  env.THRUPUT_NETWORK_HASH ??
                  "abb9cdbc56285d0e71c9845273ca06211fedf7ee2f58c43cfac6060f9402aa0f"
                ).replace(/^0x/, ""),
                "hex",
              ),
            ),
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
    // Resolve the runtime fetch implementation for each request.
    fetch: (input, init) => fetch(input, init),
  });
}
