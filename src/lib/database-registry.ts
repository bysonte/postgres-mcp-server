import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { DEFAULT_ENV_PATH, parseDatabaseDefinitions, type DatabaseDefinition } from "./config.js";
import type { AppConfig } from "./types.js";
import type { Logger } from "./logger.js";
import { logger as defaultLogger } from "./logger.js";
import { TransactionManager } from "./transaction-manager.js";

interface Connection {
  definition: DatabaseDefinition;
  pool: pg.Pool;
  transactions: TransactionManager;
  running: number;
  idle?: () => void;
}

export interface DatabaseContext {
  config: AppConfig;
  pool: pg.Pool;
  transactions: TransactionManager;
}

export interface DatabaseSummary {
  name: string;
  description: string;
  enable_write: boolean;
  enable_maintenance: boolean;
}

export interface RegistryOptions {
  envPath?: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  poolFactory?: (config: AppConfig) => pg.Pool;
  logger?: Logger;
}

/** Re-read on every tool call. A change revokes the old snapshot before any new work is admitted. */
export class DatabaseRegistry {
  private readonly envPath: string;
  private readonly explicitPath: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly args: string[];
  private readonly poolFactory: (config: AppConfig) => pg.Pool;
  private readonly log: Logger;
  private active = new Map<string, Connection>();
  private fingerprint: string | undefined;
  private fileWasPresent = false;
  private namedMode = false;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: RegistryOptions = {}) {
    this.env = options.env ?? process.env;
    this.args = options.args ?? [];
    this.explicitPath = options.envPath !== undefined || this.env.POSTGRES_ENV_PATH !== undefined;
    this.envPath = options.envPath ?? this.env.POSTGRES_ENV_PATH ?? DEFAULT_ENV_PATH;
    this.log = options.logger ?? defaultLogger;
    this.poolFactory = options.poolFactory ?? ((config) => new pg.Pool({
      connectionString: config.postgres.databaseUrl,
      max: config.postgres.maxConnections,
      idleTimeoutMillis: config.postgres.idleTimeoutMs,
      statement_timeout: config.postgres.statementTimeoutMs,
    }));
  }

  private async synchronized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }

  private async readSnapshot(): Promise<string> {
    try {
      const content = await readFile(this.envPath, "utf8");
      this.fileWasPresent = true;
      return content;
    } catch (error) {
      if (!this.explicitPath && !this.fileWasPresent && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw new Error("Configuration file is unavailable");
    }
  }

  private createConnection(definition: DatabaseDefinition): Connection {
    const { config } = definition;
    const pool = this.poolFactory(config);
    pool.on("error", () => this.log.error("Unexpected PostgreSQL idle client error"));
    const transactions = new TransactionManager(
      config.transactionTimeoutMs, config.monitorIntervalMs, config.enableTransactionMonitor, this.log,
    );
    transactions.startMonitor();
    return { definition, pool, transactions, running: 0 };
  }

  private async retire(connection: Connection): Promise<void> {
    connection.transactions.stopMonitor();
    if (connection.running) await new Promise<void>((resolve) => { connection.idle = resolve; });
    await connection.transactions.cleanupTransactions();
    try { await connection.pool.end(); } catch { this.log.error("Could not close PostgreSQL pool"); }
  }

  private async refresh(): Promise<void> {
    if (this.closed) throw new Error("Server is shutting down");
    let content: string;
    try {
      content = await this.readSnapshot();
    } catch {
      const previous = [...this.active.values()];
      this.active.clear();
      this.fingerprint = undefined;
      await Promise.all(previous.map((connection) => this.retire(connection)));
      throw new Error("Configuration unavailable: check POSTGRES_ENV_PATH");
    }
    const fingerprint = createHash("sha256").update(content).digest("hex");
    if (fingerprint === this.fingerprint) return;

    // No new calls can reach a previous generation while parsing or draining it.
    const previous = this.active;
    this.active = new Map();
    this.fingerprint = undefined;
    let definitions: ReturnType<typeof parseDatabaseDefinitions>;
    try {
      definitions = parseDatabaseDefinitions(content, this.env, this.args);
      if (this.namedMode && definitions.has("default")) throw new Error("Named databases removed");
    } catch {
      await Promise.all([...previous.values()].map((connection) => this.retire(connection)));
      throw new Error("Configuration invalid: correct the .env file to restore access");
    }
    const next = new Map<string, Connection>();
    const retired: Connection[] = [];
    for (const [name, connection] of previous) {
      const definition = definitions.get(name);
      if (!definition || JSON.stringify(definition) !== JSON.stringify(connection.definition)) retired.push(connection);
      else next.set(name, connection);
    }
    await Promise.all(retired.map((connection) => this.retire(connection)));
    try {
      for (const [name, definition] of definitions) {
        if (!next.has(name)) next.set(name, this.createConnection(definition));
      }
      this.active = next;
      if (!definitions.has("default")) this.namedMode = true;
      this.fingerprint = fingerprint;
    } catch {
      await Promise.all([...next.values()].map((connection) => this.retire(connection)));
      throw new Error("Configuration unavailable: could not initialize PostgreSQL pools");
    }
  }

  async initialize(): Promise<void> {
    await this.synchronized(() => this.refresh());
  }

  async list(): Promise<DatabaseSummary[]> {
    return this.synchronized(async () => {
      await this.refresh();
      return [...this.active].map(([name, { definition }]) => ({
        name, description: definition.description,
        enable_write: definition.config.sqlPolicy.enableWrite,
        enable_maintenance: definition.config.sqlPolicy.enableMaintenance,
      }));
    });
  }

  async withDatabase<T>(name: string, action: (context: DatabaseContext) => Promise<T>): Promise<T> {
    const connection = await this.synchronized(async () => {
      await this.refresh();
      const found = this.active.get(name);
      if (!found) throw new Error(`Unknown database: ${name}`);
      found.running++;
      return found;
    });
    try {
      return await action({ config: connection.definition.config, pool: connection.pool, transactions: connection.transactions });
    } finally {
      connection.running--;
      if (connection.running === 0) connection.idle?.();
    }
  }

  async shutdown(): Promise<void> {
    await this.synchronized(async () => {
      this.closed = true;
      const previous = [...this.active.values()];
      this.active.clear();
      await Promise.all(previous.map((connection) => this.retire(connection)));
    });
  }
}
