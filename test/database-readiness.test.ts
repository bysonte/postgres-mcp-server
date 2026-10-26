import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseRegistry } from "../src/lib/database-registry.js";
import { asPool, FakePool } from "./helpers.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const snapshot = ["SEVEN", "OTHER"].map((name) =>
  `POSTGRES_DB_${name}_URL=postgresql://fake:fake@127.0.0.1:1/fake\nPOSTGRES_DB_${name}_ENABLE_WRITE=true\nPOSTGRES_DB_${name}_ENABLE_TRANSACTION_MONITOR=false\n`,
).join("");

describe("database preparation isolation", () => {
  let registry: DatabaseRegistry;
  let beforeDatabase: ReturnType<typeof vi.fn>;
  let pools: FakePool[];
  beforeEach(() => {
    vi.mocked(readFile).mockResolvedValue(snapshot);
    pools = [];
    beforeDatabase = vi.fn().mockResolvedValue(undefined);
    registry = new DatabaseRegistry({
      envPath: "mocked.env", env: {}, logger: quiet, beforeDatabase,
      poolFactory: () => { const pool = new FakePool(); pools.push(pool); return asPool(pool); },
    });
  });
  afterEach(async () => { await registry.shutdown(); vi.clearAllMocks(); });

  it("initializes and lists without preparing a connection or changing policy", async () => {
    await registry.initialize();
    expect(await registry.list()).toEqual(["SEVEN", "OTHER"].map((name) => ({
      name, description: "", enable_write: true, enable_maintenance: false,
    })));
    expect(beforeDatabase).not.toHaveBeenCalled();
    expect(pools.every((pool) => pool.client.calls.length === 0)).toBe(true);
  });

  it("rejects unknown names before any preparation", async () => {
    await expect(registry.withDatabase("UNKNOWN", async () => null)).rejects.toThrow("Unknown database");
    expect(beforeDatabase).not.toHaveBeenCalled();
  });

  it("does not run an action when its preparation fails, and leaves other databases usable", async () => {
    beforeDatabase.mockRejectedValueOnce(new Error("SSH unavailable"));
    const query = vi.fn();
    await expect(registry.withDatabase("SEVEN", query)).rejects.toThrow("SSH unavailable");
    expect(query).not.toHaveBeenCalled();
    await expect(registry.withDatabase("OTHER", async () => "ok")).resolves.toBe("ok");
    expect(pools.every((pool) => !pool.ended)).toBe(true);
  });

  it("does not hold the shared registry queue while Seven waits for SSH", async () => {
    let finish!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    beforeDatabase.mockImplementation(async (name: string) => { if (name === "SEVEN") { started(); await waiting; } });
    const seven = registry.withDatabase("SEVEN", async () => "seven");
    await ready;
    try {
      await expect(registry.withDatabase("OTHER", async () => "independent")).resolves.toBe("independent");
      expect(await registry.list()).toHaveLength(2);
    } finally { finish(); }
    await expect(seven).resolves.toBe("seven");
  });

  it("releases the running counter on preparation failure so shutdown drains normally", async () => {
    beforeDatabase.mockRejectedValueOnce(new Error("SSH unavailable"));
    await expect(registry.withDatabase("SEVEN", async () => null)).rejects.toThrow();
    await registry.shutdown();
    expect(pools.every((pool) => pool.ended)).toBe(true);
  });
});
