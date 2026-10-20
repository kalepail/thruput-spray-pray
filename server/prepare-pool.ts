import { Worker } from "node:worker_threads";
import { once } from "node:events";
import type { Operation, PrepareRequest } from "./prepare.js";

interface Job {
  resolve: (operations: Operation[]) => void;
  reject: (error: Error) => void;
}

/** Spreads Ed25519 signing across threads so one core does not cap submission. */
export function createPreparePool(size: number, env: NodeJS.ProcessEnv) {
  // tsx runs the .ts source in development; production runs compiled .js.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const url = new URL(`./prepare-worker.${extension}`, import.meta.url);
  const workers: { worker: Worker; busy: number }[] = [];
  const jobs = new Map<number, Job>();
  let nextId = 0;
  let starting: Promise<void> | undefined;

  function fail(error: Error) {
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  }

  async function start() {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(url, { workerData: { ...env } });
      const entry = { worker, busy: 0 };
      worker.on(
        "message",
        (message: {
          id?: number;
          operations?: Operation[];
          error?: string;
        }) => {
          if (message.id === undefined) return;
          const job = jobs.get(message.id);
          if (!job) return;
          jobs.delete(message.id);
          entry.busy--;
          if (message.error) job.reject(new Error(message.error));
          else job.resolve(message.operations!);
        },
      );
      worker.on("error", (error: Error) => fail(error));
      worker.unref();
      const [ready] = await Promise.race([
        once(worker, "message"),
        once(worker, "error").then(([error]) => Promise.reject(error)),
      ]);
      if (!(ready as { ready?: boolean }).ready)
        throw new Error("Preparation worker did not start");
      workers.push(entry);
    }
  }

  return {
    size,
    async prepare(request: PrepareRequest): Promise<Operation[]> {
      await (starting ??= start().catch((error: unknown) => {
        starting = undefined;
        for (const { worker } of workers.splice(0)) void worker.terminate();
        throw error;
      }));
      const entry = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      const id = nextId++;
      entry.busy++;
      return new Promise((resolve, reject) => {
        jobs.set(id, { resolve, reject });
        entry.worker.postMessage({ id, request });
      });
    },
    async close() {
      await Promise.all(workers.map(({ worker }) => worker.terminate()));
    },
  };
}
