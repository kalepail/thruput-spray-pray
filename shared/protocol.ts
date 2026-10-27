export interface Settings {
  batchSize: number;
  concurrency: number;
}
export const defaults: Settings = {
  batchSize: 128,
  concurrency: 4,
};
export interface Point {
  x: number;
  y: number;
}

export interface Snapshot {
  phase: "connecting" | "funding" | "ready" | "spraying" | "draining" | "error";
  message: string;
  settings: Settings;
  walletCount: number;
  owner: string | null;
  attempted: number;
  accepted: number;
  succeeded: number;
  failed: number;
  unresolved: number;
  /** Transfers resent with identical bytes after the scheduler reported a retryable conflict. */
  resubmitted: number;
  pending: number;
  liveTps: number;
  submitTps: number;
  /** Transfers handed to submission in the last second. */
  sendingTps: number;
  /** Successful transfers in the latest five blocks this experiment landed in. */
  recentBlocks: { height: string; succeeded: number }[];
  averageTps: number;
  averageTxPerBlock: number;
  observedBlocks: number;
  pendingLimit: number;
  averageReceiptMs: number;
  elapsedMs: number;
  backpressure: boolean;
  errors: string[];
  network: string;
  addresses: string[];
}
export type ServerMessage =
  | { type: "hello"; id: string }
  | { type: "state"; state: Snapshot }
  | { type: "particles"; count: number; point: Point; sequence: number }
  | { type: "error"; message: string };
