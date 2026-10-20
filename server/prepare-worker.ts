import { parentPort, workerData } from "node:worker_threads";
import { WALLET_COUNT } from "../shared/protocol.js";
import { networkConfig } from "./network.js";
import {
  connectClient,
  createPreparer,
  demoWallet,
  type PrepareRequest,
} from "./prepare.js";

const config = networkConfig(workerData as NodeJS.ProcessEnv);
const client = await connectClient(config);
const prepare = createPreparer(
  Array.from({ length: WALLET_COUNT }, (_, index) => demoWallet(client, index)),
);

parentPort!.on(
  "message",
  async ({ id, request }: { id: number; request: PrepareRequest }) => {
    try {
      parentPort!.postMessage({ id, operations: await prepare(request) });
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
parentPort!.postMessage({ ready: true });
