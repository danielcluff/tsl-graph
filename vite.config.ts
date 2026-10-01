import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

// Builds the playground app (playground/server.ts serves it in dev).
export default defineConfig({
  root: "playground",
  plugins: [solid(), tailwindcss()],
  build: { target: "esnext", chunkSizeWarningLimit: 4000, outDir: "../dist", emptyOutDir: true },
});
