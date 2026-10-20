import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser } from "playwright";
import WebSocket from "ws";
import { browserOptions } from "./browser-options.js";

await access("dist/server/server/index.js");
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const address = probe.address();
assert.ok(address && typeof address !== "string");
await new Promise<void>((resolve) => probe.close(() => resolve()));
const url = `http://127.0.0.1:${address.port}`;
const secrets = [
  "username-fixture",
  "password-fixture",
  "path-fixture",
  "query-fixture",
];
const rpcUrl = `http://${secrets[0]}:${secrets[1]}@127.0.0.1:1/${secrets[2]}?token=${secrets[3]}`;
// Invalid URL credentials exercise setup-error responses without reaching a blockchain.
const server = spawn(process.execPath, ["dist/server/server/index.js"], {
  env: {
    ...process.env,
    PORT: String(address.port),
    HOST: "0.0.0.0",
    THRUPUT_NETWORK: "localnet",
    THRUPUT_RPC_URL: rpcUrl,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (data: Buffer) => {
  logs += data.toString();
});
server.stderr.on("data", (data: Buffer) => {
  logs += data.toString();
});
const exited = once(server, "exit");
let browser: Browser | undefined;
let socket: WebSocket | undefined;
function assertRedacted(text: string) {
  for (const secret of secrets)
    assert.ok(!text.includes(secret), `Public output included ${secret}`);
  assert.ok(!text.includes(rpcUrl));
}

try {
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(server.exitCode, null, "App exited before becoming ready");
    try {
      const response = await fetch(`${url}/api/state`, {
        signal: AbortSignal.timeout(1000),
      });
      const state = (await response.json()) as { phase: string };
      if (state.phase === "error") {
        ready = true;
        break;
      }
    } catch {
      /* Startup can precede the HTTP listener. */
    }
    await sleep(100);
  }
  assert.ok(
    ready,
    "Expected the credential-bearing fixture to reach setup error",
  );
  for (const path of ["/api/state", "/api/export"]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assertRedacted(body);
    assert.equal(Object.hasOwn(JSON.parse(body), "rpcUrl"), false);
  }

  socket = new WebSocket(`${url.replace("http:", "ws:")}/live`);
  const stateMessage = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No WebSocket state received")),
      5000,
    );
    socket!.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket!.on("message", (raw) => {
      const body = raw.toString();
      if (JSON.parse(body).type === "state") {
        clearTimeout(timer);
        resolve(body);
      }
    });
  });
  assertRedacted(stateMessage);
  assertRedacted(logs);

  const options = browserOptions();
  browser = await chromium.launch({
    ...options,
    args: ["--enable-automation"],
  });
  const session = await browser.newBrowserCDPSession();
  const command = await session.send("Browser.getBrowserCommandLine");
  assert.equal(
    command.arguments.includes("--no-sandbox"),
    !options.chromiumSandbox,
  );
  const page = await browser.newPage();
  const external: string[] = [];
  const fonts: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.request().resourceType() === "font" && response.ok())
      fonts.push(response.url());
  });
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (
      ["http:", "https:"].includes(target.protocol) &&
      target.origin !== url
    ) {
      external.push(target.href);
      await route.abort();
    } else await route.continue();
  });
  await page.goto(url);
  assert.ok(
    await page.evaluate(async () => {
      await document.fonts.load("16px InterVariable");
      return document.fonts.check("16px InterVariable");
    }),
  );
  assert.ok(
    fonts.length > 0,
    "Expected a successful same-origin font response",
  );
  assert.ok(fonts.every((font) => new URL(font).origin === url));
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  const license = await fetch(`${url}/fonts/OFL.txt`);
  assert.ok((await license.text()).includes("SIL OPEN FONT LICENSE"));
  console.log(
    JSON.stringify({
      publicEndpoints: "credentials redacted",
      websocket: "credentials redacted",
      chromiumSandbox: options.chromiumSandbox,
      font: "same-origin, loaded",
      externalRequests: external.length,
    }),
  );
} finally {
  socket?.terminate();
  await browser?.close();
  const forceExit = setTimeout(() => server.kill("SIGKILL"), 5000);
  server.kill("SIGTERM");
  await exited;
  clearTimeout(forceExit);
}
