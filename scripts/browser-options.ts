import type { LaunchOptions } from "playwright";

export function browserOptions(
  env: NodeJS.ProcessEnv = process.env,
): LaunchOptions {
  return {
    executablePath: env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    // Playwright itself defaults this to false; removing --no-sandbox is not enough.
    chromiumSandbox: env.CHROMIUM_DISABLE_SANDBOX !== "1",
  };
}
