import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import WebSocket from "ws";
import { browserOptions } from "./browser-options.js";

// Read-only checks against a deployed app; nothing here sprays transfers.
const url = new URL(process.env.APP_URL ?? "http://127.0.0.1:5173").origin;
let browser: Browser | undefined;
let socket: WebSocket | undefined;
function assertNoRpcUrl(text: string) {
  // The RPC URL can carry credentials in other deployments; it is never public.
  assert.ok(
    !/https?:\/\/[^"\s]*rpc/i.test(text),
    "Public output names an RPC URL",
  );
}

try {
  for (const path of ["/api/state", "/api/export"]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assertNoRpcUrl(body);
    assert.equal(Object.hasOwn(JSON.parse(body), "rpcUrl"), false);
  }
  const crossOrigin = new WebSocket(`${url.replace(/^http/, "ws")}/live`, {
    headers: { Origin: "https://example.com" },
  });
  const status = await new Promise<number>((resolve) => {
    crossOrigin.on("unexpected-response", (_, response) =>
      resolve(response.statusCode ?? 0),
    );
    crossOrigin.on("open", () => resolve(101));
    crossOrigin.on("error", () => {});
  });
  crossOrigin.terminate();
  assert.equal(status, 403, "A cross-origin WebSocket must be refused");

  socket = new WebSocket(`${url.replace(/^http/, "ws")}/live`);
  const stateMessage = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No WebSocket state received")),
      10_000,
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
  assertNoRpcUrl(stateMessage);

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
      publicEndpoints: "no RPC URL",
      crossOriginWebSocket: "refused",
      chromiumSandbox: options.chromiumSandbox,
      font: "same-origin, loaded",
      externalRequests: external.length,
    }),
  );
} finally {
  socket?.terminate();
  await browser?.close();
}
