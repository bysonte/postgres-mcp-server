import type pg from "pg";
import { SQL_KIND, type SqlPolicy, type ToolResponse } from "./types.js";
import { jsonResponse, errorResponse } from "./mcp-response.js";
import { validateSql } from "./sql-validation.js";
import { generateTransactionId, safelyReleaseClient, safeErrorMessage } from "./utils.js";
import { TransactionManager } from "./transaction-manager.js";

export interface QueryOptions {
  policy: SqlPolicy;
  transactionTimeoutMs: number;
  maxConcurrentTransactions: number;
}

function fieldSummary(fields: pg.FieldDef[] | undefined): Array<{ name: string; dataTypeID: number }> {
  return (fields ?? []).map((field) => ({ name: field.name, dataTypeID: field.dataTypeID }));
}

export async function executeReadQuery(pool: pg.Pool, sql: string, policy: SqlPolicy): Promise<ToolResponse> {
  const validation = validateSql(sql, SQL_KIND.READ, policy);
  if (!validation.ok) return errorResponse(validation.message);

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const start = Date.now();
    const result = await client.query(validation.sql);
    await client.query("COMMIT");
    return jsonResponse({
      rows: result.rows,
      rowCount: result.rowCount,
      fields: fieldSummary(result.fields),
      execution_time_ms: Date.now() - start,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failure; original error is returned safely.
    }
    return errorResponse(error, "PostgreSQL error");
  } finally {
    safelyReleaseClient(client);
  }
}

export async function executeWriteQuery(
  pool: pg.Pool,
  transactionManager: TransactionManager,
  sql: string,
  options: QueryOptions,
): Promise<ToolResponse> {
  const validation = validateSql(sql, SQL_KIND.WRITE, options.policy);
  if (!validation.ok) return errorResponse(validation.message);
  if (transactionManager.transactionCount >= options.maxConcurrentTransactions) {
    return errorResponse(`Maximum concurrent transactions reached (${options.maxConcurrentTransactions})`);
  }

  const client = await pool.connect();
  let stored = false;
  try {
    await client.query("BEGIN");
    const start = Date.now();
    const result = await client.query(validation.sql);
    const transactionId = generateTransactionId();
    transactionManager.addTransaction(transactionId, client, validation.sql);
    stored = true;
    return jsonResponse({
      status: "pending",
      transaction_id: transactionId,
      result: { command: result.command, rowCount: result.rowCount, execution_time_ms: Date.now() - start },
      timeout_ms: options.transactionTimeoutMs,
      next_step: "Review the result, then call execute_commit or execute_rollback with the transaction_id.",
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failure.
    }
    return errorResponse(error, "PostgreSQL error");
  } finally {
    if (!stored) safelyReleaseClient(client);
  }
}

export async function executeMaintenanceQuery(pool: pg.Pool, sql: string, policy: SqlPolicy): Promise<ToolResponse> {
  const validation = validateSql(sql, SQL_KIND.MAINTENANCE, policy);
  if (!validation.ok) return errorResponse(validation.message);

  const client = await pool.connect();
  try {
    const start = Date.now();
    const result = await client.query(validation.sql);
    return jsonResponse({ status: "completed", command: result.command, rowCount: result.rowCount, execution_time_ms: Date.now() - start });
  } catch (error) {
    return errorResponse(error, "PostgreSQL error");
  } finally {
    safelyReleaseClient(client);
  }
}

export async function commitTransaction(transactionManager: TransactionManager, transactionId: string): Promise<ToolResponse> {
  const transaction = transactionManager.getTransaction(transactionId);
  if (!transaction || transaction.released) {
    transactionManager.removeTransaction(transactionId);
    return errorResponse("Transaction not found or already closed");
  }

  try {
    await transaction.client.query("COMMIT");
    return jsonResponse({ status: "committed", transaction_id: transactionId });
  } catch (error) {
    try {
      await transaction.client.query("ROLLBACK");
    } catch {
      // Ignore rollback failure.
    }
    return errorResponse(`Commit failed: ${safeErrorMessage(error)}`);
  } finally {
    transaction.released = true;
    safelyReleaseClient(transaction.client);
    transactionManager.removeTransaction(transactionId);
  }
}

export async function rollbackTransaction(transactionManager: TransactionManager, transactionId: string): Promise<ToolResponse> {
  const transaction = transactionManager.getTransaction(transactionId);
  if (!transaction || transaction.released) {
    transactionManager.removeTransaction(transactionId);
    return errorResponse("Transaction not found or already closed");
  }

  try {
    await transaction.client.query("ROLLBACK");
    return jsonResponse({ status: "rolled_back", transaction_id: transactionId });
  } catch (error) {
    return errorResponse(`Rollback failed: ${safeErrorMessage(error)}`);
  } finally {
    transaction.released = true;
    safelyReleaseClient(transaction.client);
    transactionManager.removeTransaction(transactionId);
  }
}
