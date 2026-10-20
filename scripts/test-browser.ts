import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import WebSocket from "ws";
import type { Settings, Snapshot } from "../shared/protocol.js";
import { browserOptions } from "./browser-options.js";

const url = process.env.APP_URL ?? "http://127.0.0.1:5177";
const browser = await chromium.launch(browserOptions());
await mkdir("test-results", { recursive: true });
const errors: string[] = [];
const state = async (): Promise<Snapshot> =>
  (await fetch(`${url}/api/state`)).json() as Promise<Snapshot>;
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on("pageerror", (error) => errors.push(error.message));
async function waitReady() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await state();
    if (
      current.phase === "ready" &&
      current.pending === 0 &&
      current.owner === null
    )
      return;
    await page.waitForTimeout(200);
  }
  throw new Error(
    `Pipeline did not become ready: ${JSON.stringify(await state())}`,
  );
}
/** The test tunes the shared app; put back the settings it found. */
async function restoreSettings(settings: Settings) {
  await waitReady();
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/live`);
  await new Promise((resolve, reject) =>
    socket.once("open", resolve).once("error", reject),
  );
  try {
    socket.send(JSON.stringify({ type: "configure", settings }));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const current = await state();
      if (
        current.phase === "ready" &&
        current.settings.batchSize === settings.batchSize &&
        current.settings.concurrency === settings.concurrency
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Could not restore the starting settings");
  } finally {
    socket.terminate();
  }
}
const starting = (await state()).settings;
try {
  await page.goto(url);
  await waitReady();
  assert.equal((await state()).walletCount, 4);
  assert.equal((await state()).addresses.length, 4);
  await page.screenshot({ path: "test-results/desktop-idle.png" });
  await page.getByRole("button", { name: "Control room", exact: true }).click();
  await page.getByRole("button", { name: "Reset stats", exact: true }).click();
  await page.getByRole("button", { name: "Close control room" }).click();
  await page.mouse.move(360, 400);
  await page.mouse.down();
  const start = Date.now();
  for (let i = 0; i < 120; i++) {
    await page.mouse.move(
      720 + Math.cos(i / 15) * 310,
      420 + Math.sin(i / 10) * 170,
    );
    await page.waitForTimeout(70);
    if (i === 90)
      await page.screenshot({ path: "test-results/desktop-spray.png" });
  }
  await page.mouse.up();
  const stopped = await state();
  await waitReady();
  const result = await state();
  assert.ok(result.succeeded > 0, "Browser drag must commit real transfers");
  assert.equal(result.failed, 0, "No explicit transfer failures");
  assert.equal(result.unresolved, 0, "All submitted transfers must resolve");
  assert.equal(result.succeeded, result.attempted);
  assert.ok(
    result.observedBlocks > 0,
    "Receipts expose actual inclusion heights",
  );
  assert.equal(
    result.averageTxPerBlock,
    result.succeeded / result.observedBlocks,
  );
  assert.equal(result.owner, null);
  await page.waitForTimeout(500);
  assert.equal(
    (await state()).attempted,
    result.attempted,
    "Release must stop new submissions",
  );
  assert.equal(
    Number(await page.locator("#canvas").getAttribute("data-emitted")),
    result.attempted,
  );
  await page.getByRole("button", { name: "Control room", exact: true }).click();
  await page.screenshot({ path: "test-results/desktop-controls.png" });
  assert.equal(
    await page.locator("#average-tx-per-block").textContent(),
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
      result.averageTxPerBlock,
    ),
  );
  assert.equal(await page.locator("#wallets").count(), 0);
  await page.getByText("Load tuning", { exact: true }).click();
  await page.locator("#batch-size").fill("64");
  await page.locator("#concurrency").fill("2");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.waitForFunction(
    async () =>
      (await (await fetch("/api/state")).json()).settings.batchSize === 64,
  );
  await waitReady();
  assert.equal((await state()).settings.batchSize, 64);
  assert.equal((await state()).settings.concurrency, 2);
  assert.equal((await state()).walletCount, 4);
  assert.equal((await state()).addresses.length, 4);
  await page.getByRole("button", { name: "Close control room" }).click();
  await page.locator("#canvas").focus();
  await page.keyboard.down("Space");
  await page.waitForTimeout(800);
  await page.keyboard.up("Space");
  await waitReady();
  assert.ok(
    (await state()).succeeded > result.succeeded,
    "Keyboard spray works",
  );
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await waitReady();
  assert.equal((await state()).owner, null, "Blur stops the spray");
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.reload();
  await waitReady();
  assert.equal(
    (await state()).owner,
    null,
    "Reload/disconnect stops the spray",
  );
  await page.getByRole("button", { name: "Control room", exact: true }).click();
  await page.getByText("Load tuning", { exact: true }).click();
  await page.locator("#batch-size").fill("128");
  await page.locator("#concurrency").fill("4");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.waitForFunction(
    async () =>
      (await (await fetch("/api/state")).json()).settings.batchSize === 128,
  );
  await waitReady();
  await page.getByRole("button", { name: "Close control room" }).click();
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(url);
  await mobile
    .getByRole("button", { name: "Control room", exact: true })
    .click();
  assert.ok(await mobile.locator("#reduced-motion").isChecked());
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mobile.screenshot({ path: "test-results/mobile-controls.png" });
  await mobile.getByRole("button", { name: "Close control room" }).click();
  await mobile.screenshot({ path: "test-results/mobile-canvas.png" });
  const beforeTouch = (await state()).attempted;
  const cdp = await mobile.context().newCDPSession(mobile);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 180, y: 350 }],
  });
  await mobile.waitForTimeout(500);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 240, y: 420 }],
  });
  await mobile.waitForTimeout(500);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await waitReady();
  assert.ok(
    (await state()).attempted > beforeTouch,
    "Touch drag submits real transactions",
  );
  assert.equal((await state()).owner, null, "Touch release stops the spray");
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    browserDragMs: Date.now() - start,
    atRelease: stopped,
    drained: result,
    browserErrors: errors,
  };
  await writeFile(
    "test-results/browser-run.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        attempted: result.attempted,
        succeeded: result.succeeded,
        averageTps: Math.round(result.averageTps),
        elapsedMs: Math.round(result.elapsedMs),
        failures: result.failed,
        unresolved: result.unresolved,
        screenshots: "test-results/",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await restoreSettings(starting);
}
