export function hexBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (!/^(?:[0-9a-f]{2})*$/i.test(clean)) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
