// Serves the playground (fixture page: playground/e2e.html) for the browser tests.
import { join } from "node:path";
import { createServer } from "vite";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const server = await createServer({
    configFile: join(import.meta.dirname, "../../vite.config.ts"),
    server: { port: 5190, strictPort: false, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  project.provide("baseUrl", server.resolvedUrls!.local[0].replace(/\/$/, ""));
  return () => server.close();
}
