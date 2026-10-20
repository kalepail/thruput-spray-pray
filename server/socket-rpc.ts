import { connect } from "cloudflare:sockets";

/**
 * JSON-RPC POSTs over a pool of persistent HTTP/1.1 keep-alive TLS sockets.
 *
 * A Worker invocation may have only six fetch() calls waiting for response headers at
 * once, and the RPC sends headers only after it has processed a whole batch. Sockets
 * count toward that limit only while they open, so a pool keeps many batches in flight.
 */
export interface SocketPool {
  post(body: string): Promise<{ status: number; text: string }>;
  close(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CRLF2 = [13, 10, 13, 10];
const TIMEOUT_MS = 10_000;

class Connection {
  private socket;
  private reader;
  private writer;
  private buffer: Uint8Array = new Uint8Array(0);
  dead = false;

  constructor(
    private host: string,
    port: number,
  ) {
    this.socket = connect(
      { hostname: host, port },
      { secureTransport: "on", allowHalfOpen: false },
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.socket.closed.then(
      () => (this.dead = true),
      () => (this.dead = true),
    );
  }

  async post(path: string, body: string) {
    const payload = encoder.encode(body);
    const head = encoder.encode(
      `POST ${path} HTTP/1.1\r\nHost: ${this.host}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: keep-alive\r\n\r\n`,
    );
    const request = new Uint8Array(head.length + payload.length);
    request.set(head);
    request.set(payload, head.length);
    // One write: each separate write can cost a round trip.
    await this.writer.write(request);
    const headerEnd = await this.fill((b) => indexOf(b, CRLF2));
    const headerText = decoder.decode(this.buffer.subarray(0, headerEnd));
    this.consume(headerEnd + 4);
    const [statusLine, ...lines] = headerText.split("\r\n");
    const status = Number(statusLine!.split(" ")[1]);
    const headers = new Map(
      lines.map((line) => {
        const colon = line.indexOf(":");
        return [
          line.slice(0, colon).trim().toLowerCase(),
          line
            .slice(colon + 1)
            .trim()
            .toLowerCase(),
        ];
      }),
    );
    let bytes: Uint8Array;
    if (headers.get("transfer-encoding")?.includes("chunked")) {
      const chunks: Uint8Array[] = [];
      for (;;) {
        const lineEnd = await this.fill((b) => indexOf(b, [13, 10]));
        const size = parseInt(
          decoder.decode(this.buffer.subarray(0, lineEnd)).split(";")[0]!,
          16,
        );
        this.consume(lineEnd + 2);
        await this.fill((b) => (b.length >= size + 2 ? size : -1));
        chunks.push(this.buffer.slice(0, size));
        this.consume(size + 2);
        if (size === 0) break;
      }
      bytes = concat(chunks);
    } else {
      const length = Number(headers.get("content-length") ?? NaN);
      if (!Number.isInteger(length))
        throw new Error("RPC response has no length");
      bytes = await this.readExactly(length);
    }
    if (headers.get("connection") === "close") this.close();
    return { status, text: decoder.decode(bytes) };
  }

  /** Reads until `found` returns an index into the buffer. */
  private async fill(found: (buffer: Uint8Array) => number): Promise<number> {
    for (;;) {
      const at = found(this.buffer);
      if (at >= 0) return at;
      const { value, done } = await this.reader.read();
      if (done) {
        this.dead = true;
        throw new Error("RPC connection closed");
      }
      this.buffer = concat([this.buffer, value as Uint8Array]);
    }
  }

  /** Reads a known-length body without re-copying the buffer on every chunk. */
  private async readExactly(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let filled = Math.min(length, this.buffer.length);
    out.set(this.buffer.subarray(0, filled));
    this.consume(filled);
    while (filled < length) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.dead = true;
        throw new Error("RPC connection closed");
      }
      const chunk = value as Uint8Array;
      const take = Math.min(chunk.length, length - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      // A keep-alive server sends nothing after the body until the next request.
      if (take < chunk.length) this.buffer = chunk.subarray(take);
    }
    return out;
  }

  private consume(n: number) {
    this.buffer = this.buffer.subarray(n);
  }

  close() {
    this.dead = true;
    void this.socket.close().catch(() => {});
  }
}

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function socketPool(url: string, size: number): SocketPool {
  const { hostname, port, pathname, protocol } = new URL(url);
  if (protocol !== "https:") throw new Error("Socket RPC requires https");
  const idle: Connection[] = [];
  const waiting: ((connection: Connection) => void)[] = [];
  let open = 0;

  async function acquire(): Promise<Connection> {
    for (;;) {
      const connection = idle.pop();
      if (!connection) break;
      if (!connection.dead) return connection;
      open--;
    }
    if (open < size) {
      open++;
      return new Connection(hostname, Number(port || 443));
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release(connection: Connection) {
    if (connection.dead) {
      open--;
      // A waiter takes a fresh connection instead.
      const next = waiting.shift();
      if (next) {
        open++;
        next(new Connection(hostname, Number(port || 443)));
      }
      return;
    }
    const next = waiting.shift();
    if (next) next(connection);
    else idle.push(connection);
  }

  return {
    async post(body) {
      // A keep-alive socket the server closed while idle fails before any response
      // byte. Retry that once on a new connection; RPC batches here are idempotent.
      for (let attempt = 0; ; attempt++) {
        const connection = await acquire();
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          const response = await Promise.race([
            connection.post(pathname || "/", body),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("RPC request timed out")),
                TIMEOUT_MS,
              );
            }),
          ]);
          if (timer !== null) clearTimeout(timer);
          release(connection);
          return response;
        } catch (error) {
          if (timer !== null) clearTimeout(timer);
          connection.close();
          release(connection);
          if (attempt >= 1) throw error;
        }
      }
    },
    close() {
      for (const connection of idle.splice(0)) connection.close();
    },
  };
}
