/** RPC URLs can contain credentials in their authority, path, or query. */
export function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s<>"']+/gi, "[RPC endpoint]")
    .slice(0, 300);
}

/** The RPC connection failed before a complete response; the request may have landed. */
export class RpcConnectionError extends Error {
  override name = "RpcConnectionError";
}
