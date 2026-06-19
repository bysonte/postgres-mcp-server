import type pg from "pg";
import { jsonResponse, errorResponse } from "./mcp-response.js";
import type { ToolResponse } from "./types.js";
import { safelyReleaseClient } from "./utils.js";

const LIST_SCHEMAS_SQL = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
  ORDER BY schema_name
`;

const LIST_TABLES_SQL = `
  SELECT t.table_schema, t.table_name, t.table_type,
    (SELECT COUNT(*)::int FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS column_count
  FROM information_schema.tables t
  WHERE ($1::text IS NULL OR t.table_schema = $1)
    AND t.table_schema NOT LIKE 'pg_%'
    AND t.table_schema <> 'information_schema'
  ORDER BY t.table_schema, t.table_name
`;

const COLUMNS_SQL = `
  SELECT column_name, data_type, character_maximum_length, column_default, is_nullable, ordinal_position
  FROM information_schema.columns
  WHERE table_schema = $1 AND table_name = $2
  ORDER BY ordinal_position
`;

const INDEXES_SQL = `
  SELECT i.relname AS index_name, am.amname AS index_type, ix.indisunique AS is_unique, array_agg(a.attname ORDER BY a.attnum) AS column_names
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_index ix ON t.oid = ix.indrelid
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_am am ON i.relam = am.oid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
  WHERE n.nspname = $1 AND t.relname = $2
  GROUP BY i.relname, am.amname, ix.indisunique
  ORDER BY i.relname
`;

const CONSTRAINTS_SQL = `
  SELECT constraint_name, constraint_type
  FROM information_schema.table_constraints
  WHERE table_schema = $1 AND table_name = $2
  ORDER BY constraint_type, constraint_name
`;

export async function listSchemas(pool: pg.Pool): Promise<ToolResponse> {
  const client = await pool.connect();
  try {
    const result = await client.query(LIST_SCHEMAS_SQL);
    return jsonResponse(result.rows);
  } catch (error) {
    return errorResponse(error, "PostgreSQL error");
  } finally {
    safelyReleaseClient(client);
  }
}

export async function listTables(pool: pg.Pool, schemaName?: string): Promise<ToolResponse> {
  const client = await pool.connect();
  try {
    const result = await client.query(LIST_TABLES_SQL, [schemaName ?? null]);
    return jsonResponse(result.rows);
  } catch (error) {
    return errorResponse(error, "PostgreSQL error");
  } finally {
    safelyReleaseClient(client);
  }
}

export async function describeTable(pool: pg.Pool, schemaName: string, tableName: string): Promise<ToolResponse> {
  const client = await pool.connect();
  try {
    const [columns, indexes, constraints] = await Promise.all([
      client.query(COLUMNS_SQL, [schemaName, tableName]),
      client.query(INDEXES_SQL, [schemaName, tableName]),
      client.query(CONSTRAINTS_SQL, [schemaName, tableName]),
    ]);
    return jsonResponse({
      schema_name: schemaName,
      table_name: tableName,
      columns: columns.rows,
      indexes: indexes.rows,
      constraints: constraints.rows,
    });
  } catch (error) {
    return errorResponse(error, "PostgreSQL error");
  } finally {
    safelyReleaseClient(client);
  }
}
