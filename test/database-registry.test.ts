import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseRegistry } from "../src/lib/database-registry.js";
import { executeWriteQuery, commitTransaction } from "../src/lib/query.js";
import { asPool, FakePool } from "./helpers.js";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const url = "postgresql://example:pass@localhost/sample";
const file = (write: string) => `POSTGRES_DB_ALPHA_URL=${url}\nPOSTGRES_DB_ALPHA_ENABLE_WRITE=${write}\nPOSTGRES_DB_ALPHA_ENABLE_TRANSACTION_MONITOR=false\n`;

describe("database-registry", () => {
  let directory: string;
  let envPath: string;
  let pools: FakePool[];
  let registry: DatabaseRegistry;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "postgres-registry-"));
    envPath = join(directory, ".env");
    pools = [];
    registry = new DatabaseRegistry({
      envPath, env: {}, logger: quiet,
      poolFactory: () => {
        const pool = new FakePool();
        pools.push(pool);
        return asPool(pool);
      },
    });
  });

  afterEach(async () => {
    await registry.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it("carga varias bases sin exponer URLs y rechaza una ruta explícita inexistente", async () => {
    await expect(registry.initialize()).rejects.toThrow("Configuration unavailable");
    await writeFile(envPath, file("false") + "POSTGRES_DB_BETA_URL=postgresql://u:p@localhost/beta\n");
    expect(await registry.list()).toEqual([
      { name: "ALPHA", description: "", enable_write: false, enable_maintenance: false },
      { name: "BETA", description: "", enable_write: false, enable_maintenance: false },
    ]);
    await expect(registry.withDatabase("NOPE", async () => null)).rejects.toThrow("Unknown database");
    expect(pools).toHaveLength(2);
  });

  it("revoca permisos y revierte la transacción pendiente antes de cerrar el pool anterior", async () => {
    await writeFile(envPath, file("true"));
    await registry.initialize();
    const pending = await registry.withDatabase("ALPHA", ({ pool, transactions, config }) =>
      executeWriteQuery(pool, transactions, "INSERT INTO x VALUES(1)", {
        policy: config.sqlPolicy, transactionTimeoutMs: 1000, maxConcurrentTransactions: 5,
      }));
    const id = JSON.parse(pending.content[0]?.text ?? "{}").transaction_id as string;
    expect(id).toMatch(/^tx_/);
    await writeFile(envPath, file("false"));
    expect((await registry.list())[0]?.enable_write).toBe(false);
    expect(pools[0]?.client.calls.map((call) => call.text)).toContain("ROLLBACK");
    expect(pools[0]?.ended).toBe(true);
    expect((await registry.withDatabase("ALPHA", ({ transactions }) => commitTransaction(transactions, id))).isError).toBe(true);
    expect(pools).toHaveLength(2);
  });

  it("fail closed al encontrar archivo corrupto o ausente y se recupera al corregirlo", async () => {
    await writeFile(envPath, file("true"));
    await registry.initialize();
    await writeFile(envPath, "POSTGRES_DB_ALPHA_ENABLE_WRITE=true\n");
    await expect(registry.list()).rejects.toThrow("Configuration invalid");
    expect(pools[0]?.ended).toBe(true);
    await expect(registry.withDatabase("ALPHA", async () => null)).rejects.toThrow("Configuration invalid");
    await rm(envPath);
    await expect(registry.list()).rejects.toThrow("Configuration unavailable");
    await writeFile(envPath, file("false"));
    expect((await registry.list())[0]?.enable_write).toBe(false);
  });

  it("espera operaciones en curso antes de rotar y no admite operaciones nuevas con el snapshot anterior", async () => {
    await writeFile(envPath, file("true"));
    await registry.initialize();
    let finish!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const working = registry.withDatabase("ALPHA", async () => new Promise<void>((resolve) => { finish = resolve; started(); }));
    await startedPromise;
    await writeFile(envPath, file("false"));
    const rotation = registry.list();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(pools[0]?.ended).toBe(false);
    } finally { finish(); }
    await working;
    expect((await rotation)[0]?.enable_write).toBe(false);
    expect(pools[0]?.ended).toBe(true);
  });

  it("reutiliza conexiones no modificadas al editar otra base", async () => {
    await writeFile(envPath, file("false") + "POSTGRES_DB_BETA_URL=postgresql://u:p@localhost/beta\n");
    await registry.initialize();
    await writeFile(envPath, file("true") + "POSTGRES_DB_BETA_URL=postgresql://u:p@localhost/beta\n");
    await registry.list();
    expect(pools).toHaveLength(3);
    expect(pools[0]?.ended).toBe(true);
    expect(pools[1]?.ended).toBe(false);
  });
});
