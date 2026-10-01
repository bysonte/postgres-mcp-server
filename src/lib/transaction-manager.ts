import type pg from "pg";
import type { TrackedTransaction } from "./types.js";
import type { Logger } from "./logger.js";
import { logger as defaultLogger } from "./logger.js";
import { safelyReleaseClient } from "./utils.js";

export class TransactionManager {
  private activeTransactions = new Map<string, TrackedTransaction>();
  private terminating = new Map<string, Promise<boolean>>();
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly transactionTimeoutMs: number = 15000,
    private readonly monitorIntervalMs: number = 5000,
    private readonly monitorEnabled: boolean = true,
    private readonly logger: Logger = defaultLogger,
  ) {}

  addTransaction(id: string, client: pg.PoolClient, sql: string): void {
    this.activeTransactions.set(id, {
      id, client, startTime: Date.now(), sql: sql.substring(0, 100), state: "active", released: false,
    });
  }

  getTransaction(id: string): TrackedTransaction | undefined {
    return this.activeTransactions.get(id);
  }

  removeTransaction(id: string): boolean {
    return this.activeTransactions.delete(id);
  }

  hasTransaction(id: string): boolean {
    return this.activeTransactions.has(id);
  }

  get transactionCount(): number {
    return this.activeTransactions.size;
  }

  /** Claims the client synchronously, so commit, timeout and reload can never issue competing commands. */
  terminate(id: string, command: "COMMIT" | "ROLLBACK"): Promise<boolean> {
    const transaction = this.activeTransactions.get(id);
    if (!transaction || transaction.state !== "active" || transaction.released) return Promise.resolve(false);
    transaction.state = "terminating";
    const task = (async () => {
      try {
        await transaction.client.query(command);
        return true;
      } catch (error) {
        if (command === "COMMIT") {
          try { await transaction.client.query("ROLLBACK"); } catch { /* original error wins */ }
        }
        throw error;
      } finally {
        transaction.released = true;
        safelyReleaseClient(transaction.client);
        this.activeTransactions.delete(id);
        this.terminating.delete(id);
      }
    })();
    this.terminating.set(id, task);
    return task;
  }

  startMonitor(): void {
    if (this.monitorEnabled && !this.monitorInterval) {
      this.monitorInterval = setInterval(() => this.checkStuckTransactions(), this.monitorIntervalMs);
    }
  }

  stopMonitor(): void {
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.monitorInterval = null;
  }

  private checkStuckTransactions(): void {
    const now = Date.now();
    for (const [id, transaction] of this.activeTransactions) {
      if (transaction.state !== "active" || now - transaction.startTime <= this.transactionTimeoutMs) continue;
      this.logger.warn(`Transaction ${id} timed out; rolling back`);
      void this.terminate(id, "ROLLBACK").catch(() => this.logger.error(`Rollback failed for transaction ${id}`));
    }
  }

  async cleanupTransactions(): Promise<void> {
    this.stopMonitor();
    const tasks = [...this.terminating.values()];
    for (const [id, transaction] of this.activeTransactions) {
      if (transaction.released) {
        this.activeTransactions.delete(id);
      } else if (transaction.state === "active") {
        tasks.push(this.terminate(id, "ROLLBACK"));
      }
    }
    const results = await Promise.allSettled(tasks);
    if (results.some((result) => result.status === "rejected")) this.logger.error("Rollback failed during transaction cleanup");
  }
}
