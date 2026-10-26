import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DatabaseRegistry, type RegistryOptions } from "./lib/database-registry.js";
import { logger } from "./lib/logger.js";
import { createServer } from "./server.js";

interface RuntimeOptions {
  beforeDatabase?: RegistryOptions["beforeDatabase"];
  beforeShutdown?: () => Promise<void>;
}

/** Importable runtime: optional connection preparation is scoped to each tool call. */
export async function run(argv: string[] = process.argv.slice(2), options: RuntimeOptions = {}): Promise<void> {
  const registry = new DatabaseRegistry({ args: argv, logger, ...(options.beforeDatabase && { beforeDatabase: options.beforeDatabase }) });
  await registry.initialize();
  const server = createServer({ name: "postgres-mcp-server", version: process.env.npm_package_version ?? "1.0.0" }, { registry, logger });
  let closing = false;
  const cleanup = async () => {
    // Abort pending connection preparation before draining the registry.
    try { await options.beforeShutdown?.(); } finally { await registry.shutdown(); }
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    logger.info("Shutting down postgres-mcp-server");
    let code = 0;
    try {
      await cleanup();
      await server.close();
    } catch {
      logger.error("Shutdown failed");
      code = 1;
    }
    process.exit(code);
  };
  const stop = () => { void shutdown(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
  try {
    await server.connect(new StdioServerTransport());
    logger.info("postgres-mcp-server ready");
  } catch (error) {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdin.removeListener("end", stop);
    process.stdin.removeListener("error", stop);
    await cleanup();
    throw error;
  }
}
