import { parse } from "dotenv";
import { fileURLToPath } from "node:url";
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
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error("Boolean configuration must be true or false");
}

function readPositiveInt(env: Env, key: string, defaultValue: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

export interface DatabaseDefinition {
  description: string;
  config: AppConfig;
}

export type DatabaseDefinitions = Map<string, DatabaseDefinition>;

export const DEFAULT_ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

const DB_FIELDS = [
  "URL", "DESCRIPTION", "ENABLE_WRITE", "ENABLE_MAINTENANCE", "MAX_CONNECTIONS",
  "IDLE_TIMEOUT_MS", "STATEMENT_TIMEOUT_MS", "TRANSACTION_TIMEOUT_MS",
  "MONITOR_INTERVAL_MS", "ENABLE_TRANSACTION_MONITOR", "MAX_CONCURRENT_TRANSACTIONS",
] as const;

function validateUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
      throw new Error();
    }
  } catch {
    throw new Error("Invalid PostgreSQL URL in configuration");
  }
}

function parseFile(content: string): Env {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) throw new Error("Invalid .env syntax");
    const key = match[1];
    if (!key || keys.has(key)) throw new Error("Duplicate or invalid .env key");
    keys.add(key);
    const value = match[2]?.trimStart() ?? "";
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) {
      const end = value.lastIndexOf(value[0] ?? "");
      if (end === 0 || !/^(\s*|\s*#.*)$/.test(value.slice(end + 1))) throw new Error("Invalid .env quoted value");
    }
  }
  return parse(content);
}

/** The file is authoritative for named connections. Ambient credentials are only a legacy fallback. */
export function parseDatabaseDefinitions(content: string, runtimeEnv: Env = {}, args: string[] = []): DatabaseDefinitions {
  const fileEnv = parseFile(content);
  const names = new Set<string>();
  for (const key of Object.keys(fileEnv)) {
    if (!key.startsWith("POSTGRES_DB_")) continue;
    const field = DB_FIELDS.find((part) => key.endsWith(`_${part}`));
    const name = field ? key.slice("POSTGRES_DB_".length, -field.length - 1) : "";
    if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid database configuration key: ${key}`);
    }
    names.add(name);
  }

  const definitions: DatabaseDefinitions = new Map();
  if (names.size === 0) {
    const config = loadConfig({ ...runtimeEnv, ...fileEnv }, args);
    validateUrl(config.postgres.databaseUrl);
    definitions.set("default", { description: "Default PostgreSQL database", config });
    return definitions;
  }

  for (const name of names) {
    const prefix = `POSTGRES_DB_${name}_`;
    const url = fileEnv[`${prefix}URL`];
    if (!url) throw new Error(`Missing ${prefix}URL`);
    validateUrl(url);
    const dbEnv: Env = {
      POSTGRES_URL: url,
      POSTGRES_ENABLE_WRITE: fileEnv[`${prefix}ENABLE_WRITE`],
      POSTGRES_ENABLE_MAINTENANCE: fileEnv[`${prefix}ENABLE_MAINTENANCE`],
      PG_MAX_CONNECTIONS: fileEnv[`${prefix}MAX_CONNECTIONS`] ?? fileEnv.PG_MAX_CONNECTIONS,
      PG_IDLE_TIMEOUT_MS: fileEnv[`${prefix}IDLE_TIMEOUT_MS`] ?? fileEnv.PG_IDLE_TIMEOUT_MS,
      PG_STATEMENT_TIMEOUT_MS: fileEnv[`${prefix}STATEMENT_TIMEOUT_MS`] ?? fileEnv.PG_STATEMENT_TIMEOUT_MS,
      TRANSACTION_TIMEOUT_MS: fileEnv[`${prefix}TRANSACTION_TIMEOUT_MS`] ?? fileEnv.TRANSACTION_TIMEOUT_MS,
      MONITOR_INTERVAL_MS: fileEnv[`${prefix}MONITOR_INTERVAL_MS`] ?? fileEnv.MONITOR_INTERVAL_MS,
      ENABLE_TRANSACTION_MONITOR: fileEnv[`${prefix}ENABLE_TRANSACTION_MONITOR`] ?? fileEnv.ENABLE_TRANSACTION_MONITOR,
      MAX_CONCURRENT_TRANSACTIONS: fileEnv[`${prefix}MAX_CONCURRENT_TRANSACTIONS`] ?? fileEnv.MAX_CONCURRENT_TRANSACTIONS,
      npm_package_version: runtimeEnv.npm_package_version,
    };
    const description = fileEnv[`${prefix}DESCRIPTION`] ?? "";
    if (description.includes("\n") || description.includes("\r")) throw new Error(`Invalid ${prefix}DESCRIPTION`);
    definitions.set(name, { description, config: loadConfig(dbEnv, []) });
  }
  return definitions;
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
