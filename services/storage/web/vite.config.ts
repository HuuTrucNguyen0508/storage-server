import { cpSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const outDir = fileURLToPath(new URL("./ui-dist", import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      // Keep the placeholder the Go embed needs when the folder is empty.
      name: "keep-gitkeep",
      closeBundle() {
        writeFileSync(`${outDir}/.gitkeep`, "");
        // pdf.js loads fonts, character maps and image decoders at runtime.
        for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
          cpSync(fileURLToPath(new URL(`./node_modules/pdfjs-dist/${dir}`, import.meta.url)), `${outDir}/assets/pdfjs/${dir}`, { recursive: true });
        }
      },
    },
  ],
  build: {
    outDir,
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    fs: { allow: ["..", "../../../packages"] },
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
