import { randomUUID } from "node:crypto";
import type pg from "pg";
import { logger } from "./logger.js";

export function safelyReleaseClient(client: pg.PoolClient): void {
  try {
    client.release();
  } catch (error) {
    logger.warn("Error releasing PostgreSQL client", error);
  }
}

export function generateTransactionId(): string {
  return `tx_${randomUUID()}`;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}
