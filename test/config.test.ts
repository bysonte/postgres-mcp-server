import { describe, expect, it } from "vitest";
import { loadConfig, parseDatabaseDefinitions } from "../src/lib/config.js";

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
    expect(() => loadConfig({ POSTGRES_URL: "postgresql://u:p@h/db", PG_MAX_CONNECTIONS: "2oops" }, [])).toThrow("PG_MAX_CONNECTIONS");
  });

  it("carga varias DB con permisos y límites propios sin heredar secretos del entorno", () => {
    const definitions = parseDatabaseDefinitions(`POSTGRES_DB_DEV_URL=postgresql://dev:password@localhost/dev
POSTGRES_DB_DEV_DESCRIPTION=Development
POSTGRES_DB_DEV_ENABLE_WRITE=true
POSTGRES_DB_DEV_MAX_CONNECTIONS=3
POSTGRES_DB_PROD_URL=postgresql://prod:password@localhost/prod
POSTGRES_DB_PROD_ENABLE_MAINTENANCE=false`, { POSTGRES_URL: "postgresql://secret@elsewhere/legacy", POSTGRES_ENABLE_WRITE: "true" });
    expect([...definitions.keys()]).toEqual(["DEV", "PROD"]);
    expect(definitions.get("DEV")?.config.postgres.maxConnections).toBe(3);
    expect(definitions.get("DEV")?.config.sqlPolicy.enableWrite).toBe(true);
    expect(definitions.get("PROD")?.config.sqlPolicy).toEqual({ enableWrite: false, enableMaintenance: false });
  });

  it("rechaza configuración incompleta, IDs inválidos, URLs y permisos malformados", () => {
    expect(() => parseDatabaseDefinitions("POSTGRES_DB_DEV_ENABLE_WRITE=true")).toThrow("POSTGRES_DB_DEV_URL");
    expect(() => parseDatabaseDefinitions("POSTGRES_DB_lower_URL=postgresql://u:p@h/db")).toThrow("Invalid database");
    expect(() => parseDatabaseDefinitions("POSTGRES_DB_DEV_SECRETS=oops")).toThrow("Invalid database");
    expect(() => parseDatabaseDefinitions("POSTGRES_DB_DEV_URL=https://bad/db")).toThrow("Invalid PostgreSQL URL");
    expect(() => parseDatabaseDefinitions("POSTGRES_DB_DEV_URL=postgresql://u:p@h/db\nPOSTGRES_DB_DEV_ENABLE_WRITE=yes")).toThrow("Boolean configuration");
    expect(() => parseDatabaseDefinitions("POSTGRES_DB_DEV_URL=postgresql://u:p@h/db\nthis is not env")).toThrow(".env syntax");
    expect(() => parseDatabaseDefinitions("POSTGRES_DB_DEV_URL=postgresql://u:p@h/db\nPOSTGRES_DB_DEV_URL=postgresql://u:p@h/other")).toThrow("Duplicate");
    expect(() => parseDatabaseDefinitions("POSTGRES_DB_DEV_URL=postgresql://u:p@h/db\nPOSTGRES_DB_DEV_DESCRIPTION=\"unterminated")).toThrow("quoted value");
  });
});
