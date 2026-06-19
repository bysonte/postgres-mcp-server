import { describe, expect, it } from "vitest";
import { executeReadQuery, executeWriteQuery, executeMaintenanceQuery, commitTransaction, rollbackTransaction } from "../src/lib/query.js";
import { TransactionManager } from "../src/lib/transaction-manager.js";
import { asClient, asPool, FakeClient, FakePool } from "./helpers.js";

const denyPolicy = { enableWrite: false, enableMaintenance: false };
const allowPolicy = { enableWrite: true, enableMaintenance: true };
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("query", () => {
  it("ejecuta lectura en transacción read only", async () => {
    const client = new FakeClient([{ id: 1 }]);
    const result = await executeReadQuery(asPool(new FakePool(client)), "SELECT 1", denyPolicy);
    expect(result.isError).toBeUndefined();
    expect(client.calls.map((call) => call.text)).toEqual(["BEGIN TRANSACTION READ ONLY", "SELECT 1", "COMMIT"]);
    expect(client.released).toBe(true);
  });

  it("bloquea SQL no lectura antes de tocar la DB", async () => {
    const client = new FakeClient();
    const result = await executeReadQuery(asPool(new FakePool(client)), "DELETE FROM x", denyPolicy);
    expect(result.isError).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("hace rollback cuando falla lectura", async () => {
    const client = new FakeClient();
    client.failOn = "SELECT";
    const result = await executeReadQuery(asPool(new FakePool(client)), "SELECT * FROM x", denyPolicy);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("secret");
    expect(client.calls.map((call) => call.text)).toEqual(["BEGIN TRANSACTION READ ONLY", "SELECT * FROM x", "ROLLBACK"]);
  });

  it("bloquea escritura por defecto", async () => {
    const client = new FakeClient();
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    const result = await executeWriteQuery(asPool(new FakePool(client)), manager, "INSERT INTO x VALUES (1)", { policy: denyPolicy, transactionTimeoutMs: 1000, maxConcurrentTransactions: 1 });
    expect(result.isError).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("deja escritura habilitada como transacción pendiente", async () => {
    const client = new FakeClient();
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    const result = await executeWriteQuery(asPool(new FakePool(client)), manager, "INSERT INTO x VALUES (1)", { policy: allowPolicy, transactionTimeoutMs: 1000, maxConcurrentTransactions: 1 });
    expect(result.isError).toBeUndefined();
    expect(manager.transactionCount).toBe(1);
    expect(client.released).toBe(false);
    expect(client.calls.map((call) => call.text)).toEqual(["BEGIN", "INSERT INTO x VALUES (1)"]);
  });

  it("hace rollback y libera cuando falla escritura", async () => {
    const client = new FakeClient();
    client.failOn = "INSERT";
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    const result = await executeWriteQuery(asPool(new FakePool(client)), manager, "INSERT INTO x VALUES (1)", { policy: allowPolicy, transactionTimeoutMs: 1000, maxConcurrentTransactions: 1 });
    expect(result.isError).toBe(true);
    expect(client.calls.map((call) => call.text)).toEqual(["BEGIN", "INSERT INTO x VALUES (1)", "ROLLBACK"]);
    expect(client.released).toBe(true);
  });

  it("respeta límite de transacciones", async () => {
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    manager.addTransaction("tx", asClient(new FakeClient()), "INSERT INTO x VALUES (1)");
    const result = await executeWriteQuery(asPool(new FakePool()), manager, "INSERT INTO x VALUES (2)", { policy: allowPolicy, transactionTimeoutMs: 1000, maxConcurrentTransactions: 1 });
    expect(result.isError).toBe(true);
  });

  it("confirma y revierte transacciones", async () => {
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    const client1 = new FakeClient();
    manager.addTransaction("tx1", asClient(client1), "INSERT");
    expect((await commitTransaction(manager, "tx1")).isError).toBeUndefined();
    expect(client1.calls[0]?.text).toBe("COMMIT");
    expect(client1.released).toBe(true);

    const client2 = new FakeClient();
    manager.addTransaction("tx2", asClient(client2), "INSERT");
    expect((await rollbackTransaction(manager, "tx2")).isError).toBeUndefined();
    expect(client2.calls[0]?.text).toBe("ROLLBACK");
  });

  it("devuelve error seguro si commit o rollback fallan", async () => {
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    const client1 = new FakeClient();
    client1.failOn = "COMMIT";
    manager.addTransaction("tx1", asClient(client1), "INSERT");
    expect((await commitTransaction(manager, "tx1")).isError).toBe(true);
    expect(client1.released).toBe(true);

    const client2 = new FakeClient();
    client2.failOn = "ROLLBACK";
    manager.addTransaction("tx2", asClient(client2), "INSERT");
    expect((await rollbackTransaction(manager, "tx2")).isError).toBe(true);
    expect(client2.released).toBe(true);
  });

  it("maneja transacción inexistente", async () => {
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    expect((await commitTransaction(manager, "missing")).isError).toBe(true);
    expect((await rollbackTransaction(manager, "missing")).isError).toBe(true);
  });

  it("ejecuta mantenimiento solo con flag", async () => {
    const client = new FakeClient();
    expect((await executeMaintenanceQuery(asPool(new FakePool(client)), "VACUUM", denyPolicy)).isError).toBe(true);
    const result = await executeMaintenanceQuery(asPool(new FakePool(client)), "VACUUM", allowPolicy);
    expect(result.isError).toBeUndefined();
    expect(client.calls[0]?.text).toBe("VACUUM");
  });
});
