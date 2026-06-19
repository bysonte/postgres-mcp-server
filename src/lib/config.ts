import type { AppConfig } from "./types.js";

const DEFAULTS = {
  NAME: "postgres-mcp-server",
  VERSION: "1.0.0",
  TRANSACTION_TIMEOUT_MS: 60_000,
  MONITOR_INTERVAL_MS: 5_000,
  MAX_CONCURRENT_TRANSACTIONS: 5,
  PG_MAX_CONNECTIONS: 10,
  PG_IDLE_TIMEOUT_MS: 30_000,
  PG_STATEMENT_TIMEOUT_MS: 30_000,
} as const;

type Env = NodeJS.ProcessEnv;

function readBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
}

function readPositiveInt(env: Env, key: string, defaultValue: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

export function loadConfig(env: Env = process.env, args: string[] = process.argv.slice(2)): AppConfig {
  const databaseUrl = env.POSTGRES_URL ?? env.DATABASE_URL ?? args[0];
  if (!databaseUrl) {
    throw new Error("Missing POSTGRES_URL or DATABASE_URL. You can also pass the URL as first argument.");
  }

  return {
    name: DEFAULTS.NAME,
    version: env.npm_package_version ?? DEFAULTS.VERSION,
    postgres: {
      databaseUrl,
      maxConnections: readPositiveInt(env, "PG_MAX_CONNECTIONS", DEFAULTS.PG_MAX_CONNECTIONS),
      idleTimeoutMs: readPositiveInt(env, "PG_IDLE_TIMEOUT_MS", DEFAULTS.PG_IDLE_TIMEOUT_MS),
      statementTimeoutMs: readPositiveInt(env, "PG_STATEMENT_TIMEOUT_MS", DEFAULTS.PG_STATEMENT_TIMEOUT_MS),
    },
    transactionTimeoutMs: readPositiveInt(env, "TRANSACTION_TIMEOUT_MS", DEFAULTS.TRANSACTION_TIMEOUT_MS),
    monitorIntervalMs: readPositiveInt(env, "MONITOR_INTERVAL_MS", DEFAULTS.MONITOR_INTERVAL_MS),
    enableTransactionMonitor: readBoolean(env.ENABLE_TRANSACTION_MONITOR, true),
    maxConcurrentTransactions: readPositiveInt(env, "MAX_CONCURRENT_TRANSACTIONS", DEFAULTS.MAX_CONCURRENT_TRANSACTIONS),
    sqlPolicy: {
      enableWrite: readBoolean(env.POSTGRES_ENABLE_WRITE, false),
      enableMaintenance: readBoolean(env.POSTGRES_ENABLE_MAINTENANCE, false),
    },
  };
}
