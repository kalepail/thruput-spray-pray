import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {});
parentPort.postMessage({ ready: true });
