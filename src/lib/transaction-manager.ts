import type pg from "pg";
import type { TrackedTransaction } from "./types.js";
import type { Logger } from "./logger.js";
import { logger as defaultLogger } from "./logger.js";
import { safelyReleaseClient } from "./utils.js";

export class TransactionManager {
  private activeTransactions = new Map<string, TrackedTransaction>();
  private monitorInterval: NodeJS.Timeout | null = null;
  private readonly transactionTimeoutMs: number;
  private readonly monitorIntervalMs: number;
  private readonly monitorEnabled: boolean;
  private readonly logger: Logger;

  constructor(
    transactionTimeoutMs: number = 15000,
    monitorIntervalMs: number = 5000,
    monitorEnabled: boolean = true,
    logger: Logger = defaultLogger
  ) {
    this.transactionTimeoutMs = transactionTimeoutMs;
    this.monitorIntervalMs = monitorIntervalMs;
    this.monitorEnabled = monitorEnabled;
    this.logger = logger;
  }

  /**
   * Add a new transaction to the manager
   */
  addTransaction(id: string, client: pg.PoolClient, sql: string): void {
    this.activeTransactions.set(id, {
      id,
      client,
      startTime: Date.now(),
      sql: sql.substring(0, 100), // Store beginning of query for debugging
      state: 'active',
      released: false
    });
  }

  /**
   * Get a transaction by ID
   */
  getTransaction(id: string): TrackedTransaction | undefined {
    return this.activeTransactions.get(id);
  }

  /**
   * Remove a transaction from the manager
   */
  removeTransaction(id: string): boolean {
    return this.activeTransactions.delete(id);
  }

  /**
   * Check if a transaction exists
   */
  hasTransaction(id: string): boolean {
    return this.activeTransactions.has(id);
  }

  /**
   * Get count of active transactions
   */
  get transactionCount(): number {
    return this.activeTransactions.size;
  }

  /**
   * Start the transaction monitor
   */
  startMonitor(): void {
    if (this.monitorEnabled && !this.monitorInterval) {
      this.logger.info(`Starting transaction monitor with timeout ${this.transactionTimeoutMs}ms, checking every ${this.monitorIntervalMs}ms`);
      this.monitorInterval = setInterval(
        () => this.checkStuckTransactions(), 
        this.monitorIntervalMs
      );
    } else if (!this.monitorEnabled) {
      this.logger.info("Transaction monitor is disabled");
    }
  }

  /**
   * Stop the transaction monitor
   */
  stopMonitor(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Monitor for stuck transactions and roll them back
   */
  private checkStuckTransactions(): void {
    const now = Date.now();
    let terminatedCount = 0;
    
    for (const [id, transaction] of this.activeTransactions.entries()) {
      // Skip already released transactions awaiting cleanup
      if (transaction.released) continue;
      
      const age = now - transaction.startTime;
      
      if (age > this.transactionTimeoutMs && transaction.state === 'active') {
        this.logger.warn(`Transaction ${id} has been running for ${age}ms and will be rolled back`);
        transaction.state = 'terminating';
        terminatedCount++;
        
        // Handle in async function to avoid blocking the monitor
        (async () => {
          try {
            // Attempt rollback
            await transaction.client.query("ROLLBACK");
            this.logger.info(`Successfully rolled back stuck transaction ${id}`);
          } catch (error) {
            this.logger.error(`Error rolling back transaction ${id}`, error);
          } finally {
            // Mark as released before actually releasing to prevent double-release
            if (!transaction.released) {
              transaction.released = true;
              safelyReleaseClient(transaction.client);
            }
            this.removeTransaction(id);
          }
        })().catch(err => {
          this.logger.error(`Unhandled error in transaction cleanup for ${id}`, err);
          // Ensure cleanup even on error
          if (!transaction.released) {
            transaction.released = true;
            try {
              safelyReleaseClient(transaction.client);
            } catch (releaseErr) {
              this.logger.error(`Final release attempt failed for ${id}`, releaseErr);
            }
          }
          this.removeTransaction(id);
        });
      }
    }
    
    if (terminatedCount > 0) {
      this.logger.warn(`Terminated ${terminatedCount} stuck transactions. Remaining active: ${this.transactionCount}`);
    }
  }

  /**
   * Clean up any pending transactions 
   */
  async cleanupTransactions(): Promise<void> {
    this.logger.info(`Cleaning up ${this.transactionCount} active transactions`);
    
    const transactionEntries = Array.from(this.activeTransactions.entries());
    for (const [id, transaction] of transactionEntries) {
      // Skip already released transactions
      if (transaction.released) {
        this.logger.warn(`Transaction ${id} already marked as released, skipping cleanup`);
        this.removeTransaction(id);
        continue;
      }
      
      try {
        await transaction.client.query("ROLLBACK");
        this.logger.info(`Rolled back transaction ${id}`);
        
        // Mark as released to prevent double-release attempts
        transaction.released = true;
        safelyReleaseClient(transaction.client);
        this.removeTransaction(id);
      } catch (error) {
        this.logger.error(`Error rolling back transaction ${id}`, error);
        
        // Even on error, mark as released and attempt to release
        transaction.released = true;
        try {
          safelyReleaseClient(transaction.client);
        } catch (releaseErr) {
          this.logger.error(`Final client release failed for ${id}`, releaseErr);
        }
        this.removeTransaction(id);
      }
    }
    
    this.activeTransactions.clear();
  }
}
