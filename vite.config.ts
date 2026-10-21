import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  // The same address the app has always used locally.
  server: { host: "127.0.0.1", port: 5177, strictPort: true },
});
