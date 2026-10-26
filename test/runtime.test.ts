import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/runtime.js";

const mocks = vi.hoisted(() => ({
  registry: { initialize: vi.fn(), shutdown: vi.fn() },
  server: { connect: vi.fn(), close: vi.fn() },
  registryOptions: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/lib/database-registry.js", () => ({
  DatabaseRegistry: vi.fn(function (options) { mocks.registryOptions(options); return mocks.registry; }),
}));
vi.mock("../src/server.js", () => ({ createServer: vi.fn(() => mocks.server) }));
vi.mock("../src/lib/logger.js", () => ({ logger: mocks.logger }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn(function () {}) }));

describe("importable MCP runtime", () => {
  let signals: Map<string, () => void>;
  let input: Map<string, () => void>;
  let exit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    signals = new Map();
    input = new Map();
    mocks.registry.initialize.mockResolvedValue(undefined);
    mocks.registry.shutdown.mockResolvedValue(undefined);
    mocks.server.connect.mockResolvedValue(undefined);
    mocks.server.close.mockResolvedValue(undefined);
    vi.spyOn(process, "once").mockImplementation(((name: string, handler: () => void) => { signals.set(name, handler); return process; }) as never);
    vi.spyOn(process.stdin, "once").mockImplementation(((name: string, handler: () => void) => { input.set(name, handler); return process.stdin; }) as never);
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it("passes the lazy hook to the registry without invoking it at startup", async () => {
    const beforeDatabase = vi.fn();
    await run(["--test"], { beforeDatabase });
    expect(mocks.registryOptions).toHaveBeenCalledWith(expect.objectContaining({ args: ["--test"], beforeDatabase }));
    expect(beforeDatabase).not.toHaveBeenCalled();
    expect(mocks.server.connect).toHaveBeenCalledOnce();
  });

  it.each(["SIGINT", "SIGTERM", "end", "error"])("closes resources on %s without double cleanup", async (event) => {
    const beforeShutdown = vi.fn().mockResolvedValue(undefined);
    await run([], { beforeShutdown });
    const stop = (event.startsWith("SIG") ? signals : input).get(event)!;
    stop(); stop();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(beforeShutdown).toHaveBeenCalledOnce();
    expect(mocks.registry.shutdown).toHaveBeenCalledOnce();
    expect(beforeShutdown.mock.invocationCallOrder[0]).toBeLessThan(mocks.registry.shutdown.mock.invocationCallOrder[0]!);
    expect(mocks.server.close).toHaveBeenCalledOnce();
  });

  it("keeps the standard non-SSH entrypoint behavior", async () => {
    await run();
    expect(mocks.registryOptions.mock.calls[0]?.[0]).not.toHaveProperty("beforeDatabase");
    signals.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("drains the registry even when connection cleanup fails, without exposing raw errors", async () => {
    await run([], { beforeShutdown: vi.fn().mockRejectedValue(new Error("private detail")) });
    signals.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.registry.shutdown).toHaveBeenCalledOnce();
    expect(mocks.logger.error).toHaveBeenCalledWith("Shutdown failed");
  });

  it("cleans up and removes listeners when the MCP transport fails at startup", async () => {
    const beforeShutdown = vi.fn().mockResolvedValue(undefined);
    mocks.server.connect.mockRejectedValueOnce(new Error("transport failed"));
    const removeProcess = vi.spyOn(process, "removeListener");
    const removeInput = vi.spyOn(process.stdin, "removeListener");
    await expect(run([], { beforeShutdown })).rejects.toThrow("transport failed");
    expect(beforeShutdown).toHaveBeenCalledOnce();
    expect(mocks.registry.shutdown).toHaveBeenCalledOnce();
    expect(removeProcess).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(removeInput).toHaveBeenCalledWith("end", expect.any(Function));
  });
});
