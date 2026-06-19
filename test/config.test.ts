import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/lib/config.js";

describe("config", () => {
  it("carga URL desde env y defaults seguros", () => {
    const config = loadConfig({ POSTGRES_URL: "postgresql://u:p@localhost/db" }, []);
    expect(config.name).toBe("postgres-mcp-server");
    expect(config.sqlPolicy).toEqual({ enableWrite: false, enableMaintenance: false });
    expect(config.postgres.statementTimeoutMs).toBe(30000);
  });

  it("permite flags explícitos", () => {
    const config = loadConfig({ DATABASE_URL: "postgresql://u:p@h/db", POSTGRES_ENABLE_WRITE: "true", POSTGRES_ENABLE_MAINTENANCE: "true", PG_MAX_CONNECTIONS: "2" }, []);
    expect(config.sqlPolicy.enableWrite).toBe(true);
    expect(config.sqlPolicy.enableMaintenance).toBe(true);
    expect(config.postgres.maxConnections).toBe(2);
  });

  it("falla si falta URL sin revelar secretos", () => {
    expect(() => loadConfig({}, [])).toThrow("Missing POSTGRES_URL");
  });

  it("valida enteros positivos", () => {
    expect(() => loadConfig({ POSTGRES_URL: "postgresql://u:p@h/db", PG_MAX_CONNECTIONS: "0" }, [])).toThrow("PG_MAX_CONNECTIONS");
  });
});
