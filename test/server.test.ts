import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../src/server.js";
import type { AppConfig } from "../src/lib/types.js";
import { TransactionManager } from "../src/lib/transaction-manager.js";
import { asPool, FakePool } from "./helpers.js";

const config: AppConfig = {
  name: "postgres-mcp-server",
  version: "1.0.0",
  postgres: { databaseUrl: "postgresql://u:p@h/db", maxConnections: 1, idleTimeoutMs: 1, statementTimeoutMs: 1 },
  transactionTimeoutMs: 1000,
  monitorIntervalMs: 1000,
  enableTransactionMonitor: false,
  maxConcurrentTransactions: 1,
  sqlPolicy: { enableWrite: false, enableMaintenance: false },
};

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("server", () => {
  it("registra todas las tools con registerTool", () => {
    const spy = vi.spyOn(McpServer.prototype, "registerTool");
    createServer(config, { pool: asPool(new FakePool()), transactionManager: new TransactionManager(1000, 1000, false, logger), logger });
    const names = spy.mock.calls.map((call) => call[0]);
    expect(names).toEqual([
      "execute_query",
      "execute_dml_ddl_dcl_tcl",
      "execute_maintenance",
      "execute_commit",
      "execute_rollback",
      "list_schemas",
      "list_tables",
      "describe_table",
    ]);
    expect(spy.mock.calls[0]?.[1]).toHaveProperty("inputSchema");
    spy.mockRestore();
  });
});
