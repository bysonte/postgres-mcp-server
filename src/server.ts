import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig, ToolResponse } from "./lib/types.js";
import type { DatabaseRegistry, DatabaseContext } from "./lib/database-registry.js";
import { executeReadQuery, executeWriteQuery, executeMaintenanceQuery, commitTransaction, rollbackTransaction } from "./lib/query.js";
import { listSchemas, listTables, describeTable } from "./lib/introspection.js";
import { jsonResponse, errorResponse } from "./lib/mcp-response.js";
import type { Logger } from "./lib/logger.js";
import { logger as defaultLogger } from "./lib/logger.js";

export interface ServerDeps {
  registry: DatabaseRegistry;
  logger?: Logger;
}

async function boundary(action: () => Promise<ToolResponse>, logger: Logger): Promise<ToolResponse> {
  try {
    return await action();
  } catch (error) {
    logger.error("Tool operation failed");
    return errorResponse(error instanceof Error ? error.message : "Unexpected tool error");
  }
}

export function createServer(config: Pick<AppConfig, "name" | "version">, deps: ServerDeps): McpServer {
  const server = new McpServer({ name: config.name, version: config.version });
  const log = deps.logger ?? defaultLogger;
  const database = z.string().min(1).describe("Nombre de la base de datos, según list_databases");
  const use = (name: string, action: (context: DatabaseContext) => Promise<ToolResponse>) =>
    boundary(() => deps.registry.withDatabase(name, action), log);

  server.registerTool("list_databases", {
    description: "Lista bases de datos disponibles y sus permisos, sin mostrar credenciales. Paginar con limit y offset.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(50),
      offset: z.number().int().min(0).default(0),
    },
  }, async ({ limit, offset }) => boundary(async () => {
    const databases = await deps.registry.list();
    const page = databases.slice(offset, offset + limit);
    const hasMore = offset + limit < databases.length;
    return jsonResponse({ databases: page, has_more: hasMore, next_offset: hasMore ? offset + limit : null, total_count: databases.length });
  }, log));

  server.registerTool("execute_query", {
    description: "Ejecuta una consulta SQL de solo lectura dentro de una transacción READ ONLY.",
    inputSchema: { database, sql: z.string().min(1).describe("Consulta SELECT/WITH/EXPLAIN/SHOW") },
  }, async ({ database: name, sql }) => use(name, ({ pool, config }) => executeReadQuery(pool, sql, config.sqlPolicy)));

  server.registerTool("execute_dml_ddl_dcl_tcl", {
    description: "Ejecuta escritura SQL si ENABLE_WRITE=true para esta base de datos. Deja la transacción pendiente hasta commit o rollback.",
    inputSchema: { database, sql: z.string().min(1).describe("Sentencia INSERT/UPDATE/DELETE/MERGE/COPY") },
  }, async ({ database: name, sql }) => use(name, ({ pool, transactions, config }) => executeWriteQuery(pool, transactions, sql, {
    policy: config.sqlPolicy,
    transactionTimeoutMs: config.transactionTimeoutMs,
    maxConcurrentTransactions: config.maxConcurrentTransactions,
  })));

  server.registerTool("execute_maintenance", {
    description: "Ejecuta mantenimiento SQL si ENABLE_MAINTENANCE=true para esta base de datos.",
    inputSchema: { database, sql: z.string().min(1).describe("Sentencia DROP/TRUNCATE/ALTER/CREATE/VACUUM/ANALYZE/REINDEX/GRANT/REVOKE") },
  }, async ({ database: name, sql }) => use(name, ({ pool, config }) => executeMaintenanceQuery(pool, sql, config.sqlPolicy)));

  server.registerTool("execute_commit", {
    description: "Confirma una transacción de execute_dml_ddl_dcl_tcl en la base indicada.",
    inputSchema: { database, transaction_id: z.string().min(1).describe("ID de transacción") },
  }, async ({ database: name, transaction_id }) => use(name, ({ transactions }) => commitTransaction(transactions, transaction_id)));

  server.registerTool("execute_rollback", {
    description: "Revierte una transacción de execute_dml_ddl_dcl_tcl en la base indicada.",
    inputSchema: { database, transaction_id: z.string().min(1).describe("ID de transacción") },
  }, async ({ database: name, transaction_id }) => use(name, ({ transactions }) => rollbackTransaction(transactions, transaction_id)));

  server.registerTool("list_schemas", {
    description: "Lista esquemas visibles no internos de la base indicada.", inputSchema: { database },
  }, async ({ database: name }) => use(name, ({ pool }) => listSchemas(pool)));

  server.registerTool("list_tables", {
    description: "Lista tablas visibles de la base indicada, opcionalmente filtradas por esquema. Usa SQL parametrizado.",
    inputSchema: { database, schema_name: z.string().optional().describe("Nombre del esquema") },
  }, async ({ database: name, schema_name }) => use(name, ({ pool }) => listTables(pool, schema_name)));

  server.registerTool("describe_table", {
    description: "Describe columnas, índices y constraints de una tabla de la base indicada. Usa SQL parametrizado.",
    inputSchema: {
      database, schema_name: z.string().default("public").describe("Nombre del esquema"),
      table_name: z.string().min(1).describe("Nombre de la tabla"),
    },
  }, async ({ database: name, schema_name, table_name }) => use(name, ({ pool }) => describeTable(pool, schema_name, table_name)));

  return server;
}
