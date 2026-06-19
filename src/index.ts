#!/usr/bin/env node

import pg from "pg";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { TransactionManager } from "./lib/transaction-manager.js";
import { createServer } from "./server.js";

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfig(process.env, argv);
  const pool = new pg.Pool({
    connectionString: config.postgres.databaseUrl,
    max: config.postgres.maxConnections,
    idleTimeoutMillis: config.postgres.idleTimeoutMs,
    statement_timeout: config.postgres.statementTimeoutMs,
  });
  const transactionManager = new TransactionManager(
    config.transactionTimeoutMs,
    config.monitorIntervalMs,
    config.enableTransactionMonitor,
    logger,
  );

  process.once("SIGINT", async () => {
    logger.info("Shutting down postgres-mcp-server");
    transactionManager.stopMonitor();
    await transactionManager.cleanupTransactions();
    await pool.end();
    process.exit(0);
  });

  pool.on("error", (error) => logger.error("Unexpected PostgreSQL idle client error", error));
  logger.info(`${config.name} starting`);
  transactionManager.startMonitor();
  const server = createServer(config, { pool, transactionManager, logger });
  await server.connect(new StdioServerTransport());
  logger.info(`${config.name} ready`);
}

run().catch((error) => {
  logger.error("Startup failed", error);
  process.exit(1);
});
