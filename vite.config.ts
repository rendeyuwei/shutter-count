import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./web/", import.meta.url)),
  publicDir: fileURLToPath(new URL("./public/", import.meta.url)),
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("./dist/public/", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "app.js" } },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3020",
        rewrite: (requestPath) => "/shutter" + requestPath,
      },
    },
  },
});
