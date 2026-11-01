import { cpSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const outDir = resolve(import.meta.dirname, "dist");

// The Go embed needs web/dist/.keep to stay in git, and Vite's emptyOutDir would
// remove it. Fonts, cmaps and fallbacks for PDF rendering are served by the app,
// never a CDN.
function distFiles(): Plugin {
  return {
    name: "storage-dist-files",
    apply: "build",
    buildStart() {
      for (const name of readdirSync(outDir)) {
        if (name !== ".keep") rmSync(join(outDir, name), { recursive: true, force: true });
      }
    },
    closeBundle() {
      const pdfjs = resolve(import.meta.dirname, "node_modules/pdfjs-dist");
      for (const dir of ["standard_fonts", "cmaps", "wasm"]) {
        cpSync(join(pdfjs, dir), join(outDir, "pdfjs", dir), { recursive: true });
      }
    },
  };
}

const server = process.env.STORAGE_SERVER ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), distFiles()],
  build: { outDir, emptyOutDir: false, target: "es2023", assetsInlineLimit: 0 },
  server: {
    fs: { allow: [".."] },
    proxy: { "/api": { target: server } },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
} as Parameters<typeof defineConfig>[0]);
