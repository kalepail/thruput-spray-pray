import { Worker } from "node:worker_threads";
import { once } from "node:events";
import type { Operation, PrepareRequest } from "./prepare.js";

interface Job {
  resolve: (operations: Operation[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Entry {
  worker: Worker;
  jobs: Map<number, Job>;
}

/**
 * Spreads Ed25519 signing across threads so one core does not cap submission.
 * A failed or exited worker is dropped and rejects only its own jobs; the chain
 * then signs that range on the main thread.
 */
export function createPreparePool(
  size: number,
  env: NodeJS.ProcessEnv,
  { jobTimeoutMs = 30_000, url }: { jobTimeoutMs?: number; url?: URL } = {},
) {
  // tsx runs the .ts source in development; production runs compiled .js.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const workerUrl =
    url ?? new URL(`./prepare-worker.${extension}`, import.meta.url);
  let workers: Entry[] = [];
  let nextId = 0;
  let starting: Promise<void> | undefined;

  function retire(entry: Entry, error: Error) {
    workers = workers.filter((candidate) => candidate !== entry);
    for (const job of entry.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    entry.jobs.clear();
    void entry.worker.terminate();
  }

  async function startOne(): Promise<Entry> {
    const worker = new Worker(workerUrl, { workerData: { ...env } });
    const entry: Entry = { worker, jobs: new Map() };
    const [message] = await Promise.race([
      once(worker, "message"),
      once(worker, "error").then(([error]) => Promise.reject(error)),
      once(worker, "exit").then(() =>
        Promise.reject(new Error("Preparation worker exited during startup")),
      ),
    ]);
    if (!(message as { ready?: boolean }).ready) {
      void worker.terminate();
      throw new Error("Preparation worker did not start");
    }
    worker.on(
      "message",
      (reply: { id?: number; operations?: Operation[]; error?: string }) => {
        if (reply.id === undefined) return;
        const job = entry.jobs.get(reply.id);
        if (!job) return;
        entry.jobs.delete(reply.id);
        clearTimeout(job.timer);
        if (reply.error) job.reject(new Error(reply.error));
        else job.resolve(reply.operations!);
      },
    );
    worker.on("error", (error: Error) => retire(entry, error));
    worker.on("exit", (code) =>
      retire(entry, new Error(`Preparation worker exited (${code})`)),
    );
    worker.unref();
    return entry;
  }

  async function start() {
    const started = await Promise.allSettled(
      Array.from({ length: size }, startOne),
    );
    workers = started.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (workers.length === 0) {
      const failure = started.find((result) => result.status === "rejected");
      throw failure?.reason instanceof Error
        ? failure.reason
        : new Error("No preparation worker started");
    }
  }

  return {
    size,
    get live() {
      return workers.length;
    },
    async prepare(request: PrepareRequest): Promise<Operation[]> {
      await (starting ??= start().catch((error: unknown) => {
        starting = undefined;
        throw error;
      }));
      if (workers.length === 0) throw new Error("No preparation workers left");
      const entry = workers.reduce((a, b) =>
        b.jobs.size < a.jobs.size ? b : a,
      );
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.jobs.delete(id);
          reject(new Error("Preparation worker timed out"));
        }, jobTimeoutMs);
        entry.jobs.set(id, { resolve, reject, timer });
        entry.worker.postMessage({ id, request });
      });
    },
    async close() {
      const closing = workers;
      workers = [];
      await Promise.all(closing.map(({ worker }) => worker.terminate()));
    },
  };
}
