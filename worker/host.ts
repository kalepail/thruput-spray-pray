export interface Host {
  colo: string;
  rpcRttMs: number;
}

/** Where this object runs and its warm round trip to the RPC. */
export async function measureHost(rpcUrl: string): Promise<Host> {
  const trace = await (
    await fetch("https://cloudflare.com/cdn-cgi/trace")
  ).text();
  const samples: number[] = [];
  for (let i = 0; i < 4; i++) {
    const start = Date.now();
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"getNetworkInfo","params":{}}',
    });
    await response.arrayBuffer();
    samples.push(Date.now() - start);
  }
  // Drop the first sample: it includes the TLS handshake.
  const warm = samples.slice(1).sort((a, b) => a - b);
  return {
    colo: /colo=(\w+)/.exec(trace)?.[1] ?? "unknown",
    rpcRttMs: warm[1]!,
  };
}

/** Running timers keep objects alive across deploys; a newer caller resets them. */
export function isNewerVersion(sent: string | null | undefined, own: string) {
  return Date.parse(sent ?? "") > Date.parse(own);
}
