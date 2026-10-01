#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DatabaseRegistry } from "./lib/database-registry.js";
import { logger } from "./lib/logger.js";
import { createServer } from "./server.js";

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const registry = new DatabaseRegistry({ args: argv, logger });
  await registry.initialize();

  const shutdown = async () => {
    logger.info("Shutting down postgres-mcp-server");
    await registry.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });

  const server = createServer({ name: "postgres-mcp-server", version: process.env.npm_package_version ?? "1.0.0" }, { registry, logger });
  await server.connect(new StdioServerTransport());
  logger.info("postgres-mcp-server ready");
}

run().catch(() => {
  logger.error("Startup failed: check PostgreSQL configuration");
  process.exit(1);
});
