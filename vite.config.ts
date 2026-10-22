import { defineConfig } from "vite";
export default defineConfig({
  root: "apps/web",
  server: {
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    // Native file events can be missed when edits are made through the workspace bridge.
    // Poll so the browser never keeps an obsolete in-memory module after an edit.
    watch: { usePolling: true, interval: 400 },
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4100" },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
