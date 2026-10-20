import { test } from "node:test";
import assert from "node:assert/strict";
import { publicErrorMessage } from "../server/errors.js";
import { browserOptions } from "../scripts/browser-options.js";

test("public diagnostics redact URL credentials, paths, and tokens before truncation", () => {
  const endpoint = `https://example-user:example-password@rpc.example/private-key?token=${"secret".repeat(100)}`;
  assert.equal(
    publicErrorMessage(new Error(`Cannot fetch ${endpoint} due to timeout`)),
    "Cannot fetch [RPC endpoint] due to timeout",
  );
  assert.equal(
    publicErrorMessage(
      "Try https://rpc.example/token and http://user:pass@proxy.example/key",
    ),
    "Try [RPC endpoint] and [RPC endpoint]",
  );
  assert.equal(
    publicErrorMessage(new Error("Receipt deadline reached")),
    "Receipt deadline reached",
  );
});

test("Chromium sandbox is enabled unless explicitly disabled", () => {
  assert.equal(browserOptions({}).chromiumSandbox, true);
  assert.equal(
    browserOptions({ CHROMIUM_DISABLE_SANDBOX: "0" }).chromiumSandbox,
    true,
  );
  assert.equal(
    browserOptions({ CHROMIUM_DISABLE_SANDBOX: "true" }).chromiumSandbox,
    true,
  );
  assert.equal(
    browserOptions({ CHROMIUM_DISABLE_SANDBOX: "1" }).chromiumSandbox,
    false,
  );
  assert.equal(
    browserOptions({ CHROMIUM_PATH: "/custom/chromium" }).executablePath,
    "/custom/chromium",
  );
});
