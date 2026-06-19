import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pg from "pg";
import type { AppConfig, ToolResponse } from "./lib/types.js";
import { TransactionManager } from "./lib/transaction-manager.js";
import { executeReadQuery, executeWriteQuery, executeMaintenanceQuery, commitTransaction, rollbackTransaction } from "./lib/query.js";
import { listSchemas, listTables, describeTable } from "./lib/introspection.js";
import { errorResponse } from "./lib/mcp-response.js";
import type { Logger } from "./lib/logger.js";
import { logger as defaultLogger } from "./lib/logger.js";

export interface ServerDeps {
  pool: pg.Pool;
  transactionManager: TransactionManager;
  logger?: Logger;
}

async function boundary(action: () => Promise<ToolResponse>, logger: Logger): Promise<ToolResponse> {
  try {
    return await action();
  } catch (error) {
    logger.error("Unexpected tool error", error);
    return errorResponse("Unexpected tool error");
  }
}

export function createServer(config: AppConfig, deps: ServerDeps): McpServer {
  const server = new McpServer({ name: config.name, version: config.version });
  const log = deps.logger ?? defaultLogger;

  server.registerTool(
    "execute_query",
    {
      description: "Ejecuta una consulta SQL de solo lectura. Por seguridad corre dentro de una transacción READ ONLY.",
      inputSchema: { sql: z.string().min(1).describe("Consulta SELECT/WITH/EXPLAIN/SHOW") },
    },
    async ({ sql }) => boundary(() => executeReadQuery(deps.pool, sql, config.sqlPolicy), log),
  );

  server.registerTool(
    "execute_dml_ddl_dcl_tcl",
    {
      description: "Ejecuta escritura SQL solo si POSTGRES_ENABLE_WRITE=true. Deja la transacción pendiente hasta commit o rollback.",
      inputSchema: { sql: z.string().min(1).describe("Sentencia INSERT/UPDATE/DELETE/MERGE/COPY") },
    },
    async ({ sql }) => boundary(
      () => executeWriteQuery(deps.pool, deps.transactionManager, sql, {
        policy: config.sqlPolicy,
        transactionTimeoutMs: config.transactionTimeoutMs,
        maxConcurrentTransactions: config.maxConcurrentTransactions,
      }),
      log,
    ),
  );

  server.registerTool(
    "execute_maintenance",
    {
      description: "Ejecuta mantenimiento SQL solo si POSTGRES_ENABLE_MAINTENANCE=true.",
      inputSchema: { sql: z.string().min(1).describe("Sentencia DROP/TRUNCATE/ALTER/CREATE/VACUUM/ANALYZE/REINDEX/GRANT/REVOKE") },
    },
    async ({ sql }) => boundary(() => executeMaintenanceQuery(deps.pool, sql, config.sqlPolicy), log),
  );

  server.registerTool(
    "execute_commit",
    {
      description: "Confirma una transacción abierta por execute_dml_ddl_dcl_tcl.",
      inputSchema: { transaction_id: z.string().min(1).describe("ID de transacción") },
    },
    async ({ transaction_id }) => boundary(() => commitTransaction(deps.transactionManager, transaction_id), log),
  );

  server.registerTool(
    "execute_rollback",
    {
      description: "Revierte una transacción abierta por execute_dml_ddl_dcl_tcl.",
      inputSchema: { transaction_id: z.string().min(1).describe("ID de transacción") },
    },
    async ({ transaction_id }) => boundary(() => rollbackTransaction(deps.transactionManager, transaction_id), log),
  );

  server.registerTool(
    "list_schemas",
    {
      description: "Lista esquemas visibles no internos.",
      inputSchema: {},
    },
    async () => boundary(() => listSchemas(deps.pool), log),
  );

  server.registerTool(
    "list_tables",
    {
      description: "Lista tablas visibles, opcionalmente filtradas por esquema. Usa SQL parametrizado.",
      inputSchema: { schema_name: z.string().optional().describe("Nombre del esquema") },
    },
    async ({ schema_name }) => boundary(() => listTables(deps.pool, schema_name), log),
  );

  server.registerTool(
    "describe_table",
    {
      description: "Describe columnas, índices y constraints de una tabla. Usa SQL parametrizado.",
      inputSchema: {
        schema_name: z.string().default("public").describe("Nombre del esquema"),
        table_name: z.string().min(1).describe("Nombre de la tabla"),
      },
    },
    async ({ schema_name, table_name }) => boundary(() => describeTable(deps.pool, schema_name, table_name), log),
  );

  return server;
}
