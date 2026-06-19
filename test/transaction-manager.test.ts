import { describe, expect, it, vi } from "vitest";
import { TransactionManager } from "../src/lib/transaction-manager.js";
import { asClient, FakeClient } from "./helpers.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("transaction-manager", () => {
  it("agrega, obtiene y remueve transacciones", () => {
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    const client = new FakeClient();
    manager.addTransaction("tx", asClient(client), "SELECT 1");
    expect(manager.hasTransaction("tx")).toBe(true);
    expect(manager.getTransaction("tx")?.sql).toBe("SELECT 1");
    expect(manager.transactionCount).toBe(1);
    expect(manager.removeTransaction("tx")).toBe(true);
  });

  it("cleanup revierte y libera", async () => {
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    const client = new FakeClient();
    manager.addTransaction("tx", asClient(client), "INSERT");
    await manager.cleanupTransactions();
    expect(client.calls[0]?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
    expect(manager.transactionCount).toBe(0);
  });

  it("cleanup maneja transacciones ya liberadas y errores", async () => {
    const manager = new TransactionManager(1000, 1000, false, silentLogger);
    const released = new FakeClient();
    manager.addTransaction("released", asClient(released), "INSERT");
    const tx = manager.getTransaction("released");
    if (tx) tx.released = true;

    const broken = new FakeClient();
    broken.failOn = "ROLLBACK";
    manager.addTransaction("broken", asClient(broken), "INSERT");

    await manager.cleanupTransactions();
    expect(released.calls).toHaveLength(0);
    expect(broken.released).toBe(true);
    expect(manager.transactionCount).toBe(0);
  });

  it("monitor revierte transacciones vencidas", async () => {
    vi.useFakeTimers();
    const manager = new TransactionManager(10, 5, true, silentLogger);
    const client = new FakeClient();
    manager.addTransaction("tx", asClient(client), "INSERT");
    manager.startMonitor();
    await vi.advanceTimersByTimeAsync(20);
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
    manager.stopMonitor();
    vi.useRealTimers();
  });
});
