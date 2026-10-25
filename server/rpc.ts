import { z } from "zod";
import { NativeRpcErrorCode } from "@thruputchain/client";

const responseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number(), message: z.string(), data: z.unknown() })
      .partial({ data: true })
      .optional(),
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
    return row.error.code === NativeRpcErrorCode.TransactionInvalid ||
      row.error.code === NativeRpcErrorCode.TransactionRejected
      ? "rejected"
      : "unknown";
  const result = row.result as {
    transactionHash?: unknown;
    admission?: unknown;
  } | null;
  return result?.transactionHash === hash && result.admission === "accepted"
    ? "accepted"
    : "unknown";
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
  params: object[],
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
  transactionHash: z.string(),
  blockHeight: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .refine(
      (height) => BigInt(height) <= (1n << 63n) - 1n,
      "Receipt height exceeds int64",
    ),
  execution: z.object({
    result: z.enum([
      "return",
      "abort",
      "fault",
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
  if (response.error) throw new Error(`Receipt RPC: ${response.error.message}`);
  if (response.result === null) return;
  const receipt = receiptSchema.parse(response.result);
  if (receipt.transactionHash !== hash)
    throw new Error("Receipt hash mismatch");
  return {
    state: receipt.execution.result === "return" ? "succeeded" : "failed",
    height: receipt.blockHeight,
  };
}

export const TX_STATUSES = [
  "pending",
  "committed",
  "retry",
  "dropped",
  "unknown",
  "other",
] as const;
export type TxStatus = (typeof TX_STATUSES)[number] | "unavailable";

/** `getTransactionStatus` rows; an error or unexpected shape is unavailable. */
export function statusResults(rows: RpcResponse[]): TxStatus[] {
  return rows.map((row) => {
    if (row.error) return "unavailable";
    const status = (row.result as { status?: unknown } | null)?.status;
    return TX_STATUSES.find((known) => known === status) ?? "unavailable";
  });
}
