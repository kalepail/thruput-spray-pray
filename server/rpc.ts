import { z } from "zod";
import { ThruputRpcErrorCode } from "@thruputchain/client";

const responseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
  })
  .refine(
    (row) => Object.hasOwn(row, "result") !== Object.hasOwn(row, "error"),
    "RPC response must contain exactly one of result or error",
  );
export type RpcResponse = z.infer<typeof responseSchema>;

export function submissionOutcome(
  hash: string,
  row: RpcResponse,
): "accepted" | "rejected" | "unknown" {
  if (row.error)
    return row.error.code === ThruputRpcErrorCode.TxInvalid ||
      row.error.code === ThruputRpcErrorCode.TxRejected
      ? "rejected"
      : "unknown";
  return row.result === hash ? "accepted" : "unknown";
}

export type RpcPost = (
  body: string,
) => Promise<{ status: number; text: string }>;

export function fetchPost(url: string): RpcPost {
  return async (body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, text: await response.text() };
  };
}

export async function rpcBatch(
  url: string | RpcPost,
  method: string,
  params: unknown[][],
): Promise<RpcResponse[]> {
  const post = typeof url === "string" ? fetchPost(url) : url;
  const response = await post(
    JSON.stringify(
      params.map((args, id) => ({ jsonrpc: "2.0", id, method, params: args })),
    ),
  );
  if (response.status < 200 || response.status > 299)
    throw new Error(`RPC HTTP ${response.status}`);
  const rows = z.array(responseSchema).parse(JSON.parse(response.text));
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== params.length || rows.length !== params.length)
    throw new Error("RPC batch response count mismatch");
  return params.map((_, id) => {
    const row = byId.get(id);
    if (!row || (row.error === undefined && !Object.hasOwn(row, "result")))
      throw new Error("RPC batch response missing result");
    return row;
  });
}

const receiptSchema = z.object({
  txHash: z.string(),
  height: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .refine(
      (height) => BigInt(height) <= (1n << 63n) - 1n,
      "Receipt height exceeds int64",
    ),
  status: z.object({
    result: z.enum([
      "ok",
      "reverted",
      "deterministicError",
      "nonDeterministicError",
      "failedGasSponsorship",
      "other",
    ]),
  }),
});
export interface ReceiptOutcome {
  state: "succeeded" | "failed";
  height: string;
}
export type ReceiptPollResult =
  ReceiptOutcome | { state: "unavailable"; message: string } | undefined;

/** One unavailable or malformed receipt must not hide committed peers. */
export function receiptResults(
  hashes: string[],
  rows: RpcResponse[],
): ReceiptPollResult[] {
  return rows.map((row, index) => {
    try {
      return receiptOutcome(hashes[index]!, row);
    } catch (error) {
      return {
        state: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
export function receiptOutcome(
  hash: string,
  response: RpcResponse,
): ReceiptOutcome | undefined {
  if (response.error?.code === ThruputRpcErrorCode.TxNotFound) return;
  if (response.error) throw new Error(`Receipt RPC: ${response.error.message}`);
  if (response.result === null) return;
  const receipt = receiptSchema.parse(response.result);
  if (receipt.txHash !== hash) throw new Error("Receipt hash mismatch");
  return {
    state: receipt.status.result === "ok" ? "succeeded" : "failed",
    height: receipt.height,
  };
}

export const TX_STATUSES = [
  "pending",
  "committed",
  "invalid",
  "recentFailure",
  "retry",
  "dropped",
  "unknown",
  "other",
] as const;
export type TxStatus = (typeof TX_STATUSES)[number] | "unavailable";

/** `groundhog_getTransactionStatus` rows; an error or unexpected shape is unavailable. */
export function statusResults(rows: RpcResponse[]): TxStatus[] {
  return rows.map((row) => {
    if (row.error) return "unavailable";
    const status = (row.result as { status?: unknown } | null)?.status;
    return TX_STATUSES.find((known) => known === status) ?? "unavailable";
  });
}
