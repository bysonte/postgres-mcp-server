import { describe, expect, it } from "vitest";
import { classifySql, validateSql } from "../src/lib/sql-validation.js";
import { SQL_KIND } from "../src/lib/types.js";

const denyPolicy = { enableWrite: false, enableMaintenance: false };
const allowPolicy = { enableWrite: true, enableMaintenance: true };

describe("sql-validation", () => {
  it.each(["SELECT 1", "WITH q AS (SELECT 1) SELECT * FROM q", "EXPLAIN SELECT 1", "SHOW search_path", "-- ok\nSELECT 1", "/* ok */ SELECT 1;"])("permite lectura: %s", (sql) => {
    expect(validateSql(sql, SQL_KIND.READ, denyPolicy)).toMatchObject({ ok: true, kind: SQL_KIND.READ });
  });

  it.each(["", "   ", "SELECT 1; SELECT 2", "BEGIN", "COMMIT", "DO $$ BEGIN END $$"])("rechaza SQL ambiguo: %s", (sql) => {
    expect(classifySql(sql).ok).toBe(false);
  });

  it.each(["INSERT INTO a VALUES (1)", "UPDATE a SET b=1", "DELETE FROM a", "MERGE INTO a USING b ON true", "COPY a FROM STDIN"])("bloquea escritura por defecto: %s", (sql) => {
    expect(validateSql(sql, SQL_KIND.WRITE, denyPolicy)).toMatchObject({ ok: false });
    expect(validateSql(sql, SQL_KIND.WRITE, allowPolicy)).toMatchObject({ ok: true, kind: SQL_KIND.WRITE });
  });

  it.each(["DROP TABLE a", "TRUNCATE a", "ALTER TABLE a ADD COLUMN b int", "CREATE TABLE a(id int)", "VACUUM", "ANALYZE", "REINDEX TABLE a", "GRANT SELECT ON a TO b", "REVOKE SELECT ON a FROM b"])("bloquea mantenimiento por defecto: %s", (sql) => {
    expect(validateSql(sql, SQL_KIND.MAINTENANCE, denyPolicy)).toMatchObject({ ok: false });
    expect(validateSql(sql, SQL_KIND.MAINTENANCE, allowPolicy)).toMatchObject({ ok: true, kind: SQL_KIND.MAINTENANCE });
  });

  it("rechaza categoría incorrecta", () => {
    expect(validateSql("SELECT 1", SQL_KIND.WRITE, allowPolicy)).toMatchObject({ ok: false });
  });
});
