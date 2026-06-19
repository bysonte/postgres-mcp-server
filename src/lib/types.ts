import type pg from "pg";

export const SCHEMA_PATH = "schema" as const;

export const SQL_KIND = {
  READ: "read",
  WRITE: "write",
  MAINTENANCE: "maintenance",
  UNSAFE: "unsafe",
} as const;

export type SqlKind = (typeof SQL_KIND)[keyof typeof SQL_KIND];

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResponse {
  [key: string]: unknown;
  content: TextContent[];
  isError?: boolean;
}

export interface SqlPolicy {
  enableWrite: boolean;
  enableMaintenance: boolean;
}

export interface ValidationSuccess {
  ok: true;
  sql: string;
  kind: SqlKind;
}

export interface ValidationFailure {
  ok: false;
  message: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface PostgresConfig {
  databaseUrl: string;
  maxConnections: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface AppConfig {
  name: string;
  version: string;
  postgres: PostgresConfig;
  transactionTimeoutMs: number;
  monitorIntervalMs: number;
  enableTransactionMonitor: boolean;
  maxConcurrentTransactions: number;
  sqlPolicy: SqlPolicy;
}

export interface TrackedTransaction {
  id: string;
  client: pg.PoolClient;
  startTime: number;
  sql: string;
  state: "active" | "terminating";
  released: boolean;
}
