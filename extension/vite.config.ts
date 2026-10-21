import { resolve } from "node:path";
import { defineConfig } from "vite";

const extensionRoot = import.meta.dirname;
const repoRoot = resolve(extensionRoot, "..");

export default defineConfig({
  root: extensionRoot,
  publicDir: resolve(extensionRoot, "public"),
  build: {
    outDir: resolve(repoRoot, "dist"),
    emptyOutDir: true,
    target: "chrome120",
    sourcemap: false,
    rollupOptions: {
      input: {
        "service-worker": resolve(extensionRoot, "src/background/service-worker.ts"),
        popup: resolve(extensionRoot, "popup.html"),
        options: resolve(extensionRoot, "options.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
