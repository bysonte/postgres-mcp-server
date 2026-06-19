import { SQL_KIND, type SqlKind, type SqlPolicy, type ValidationResult } from "./types.js";

const READ_COMMANDS = ["SELECT", "WITH", "EXPLAIN", "SHOW"] as const;
const WRITE_COMMANDS = ["INSERT", "UPDATE", "DELETE", "MERGE", "COPY"] as const;
const MAINTENANCE_COMMANDS = ["DROP", "TRUNCATE", "ALTER", "CREATE", "VACUUM", "REINDEX", "GRANT", "REVOKE", "ANALYZE"] as const;
const TRANSACTION_COMMANDS = ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"] as const;

function stripLeadingComments(sql: string): string {
  let value = sql.trim();
  let changed = true;
  while (changed) {
    changed = false;
    if (value.startsWith("--")) {
      const nextLine = value.indexOf("\n");
      value = nextLine === -1 ? "" : value.slice(nextLine + 1).trim();
      changed = true;
    }
    if (value.startsWith("/*")) {
      const end = value.indexOf("*/");
      value = end === -1 ? "" : value.slice(end + 2).trim();
      changed = true;
    }
  }
  return value;
}

function hasMultipleStatements(sql: string): boolean {
  const withoutTrailing = sql.trim().replace(/;\s*$/, "");
  return withoutTrailing.includes(";");
}

function firstWord(sql: string): string {
  return sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
}

function startsWithAny(sql: string, words: readonly string[]): boolean {
  const word = firstWord(sql);
  return words.includes(word);
}

export function classifySql(sql: string): ValidationResult {
  const cleaned = stripLeadingComments(sql);
  if (!cleaned) return { ok: false, message: "SQL statement is required" };
  if (hasMultipleStatements(cleaned)) return { ok: false, message: "Multiple SQL statements are not allowed" };

  if (startsWithAny(cleaned, READ_COMMANDS)) return { ok: true, sql: cleaned, kind: SQL_KIND.READ };
  if (startsWithAny(cleaned, WRITE_COMMANDS)) return { ok: true, sql: cleaned, kind: SQL_KIND.WRITE };
  if (startsWithAny(cleaned, MAINTENANCE_COMMANDS)) return { ok: true, sql: cleaned, kind: SQL_KIND.MAINTENANCE };
  if (startsWithAny(cleaned, TRANSACTION_COMMANDS)) return { ok: false, message: "Transaction control statements are not allowed in SQL tools" };
  return { ok: false, message: "SQL operation is ambiguous or not supported" };
}

export function validateSql(sql: string, expected: SqlKind, policy: SqlPolicy): ValidationResult {
  const classified = classifySql(sql);
  if (!classified.ok) return classified;
  if (classified.kind !== expected) {
    return { ok: false, message: `Expected ${expected} SQL but received ${classified.kind} SQL` };
  }
  if (classified.kind === SQL_KIND.WRITE && !policy.enableWrite) {
    return { ok: false, message: "Write SQL is disabled. Set POSTGRES_ENABLE_WRITE=true to enable it." };
  }
  if (classified.kind === SQL_KIND.MAINTENANCE && !policy.enableMaintenance) {
    return { ok: false, message: "Maintenance SQL is disabled. Set POSTGRES_ENABLE_MAINTENANCE=true to enable it." };
  }
  return classified;
}
