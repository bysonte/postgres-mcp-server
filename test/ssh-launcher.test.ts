import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createConnection, createServer } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertPortAvailable, launch, parseTunnelConfig, probePostgres, sshArguments, waitForPostgres } from "../scripts/ssh-launcher.mjs";

vi.mock("node:net", () => ({ createConnection: vi.fn(), createServer: vi.fn() }));

const config = parseTunnelConfig({ host: "vps.example.com", user: "operator" });

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  stdin = new PassThrough();
  kill = vi.fn(() => {
    this.killed = true;
    this.signalCode = "SIGTERM";
    this.emit("exit", null, "SIGTERM");
    return true;
  });
}

function setup(overrides = {}) {
  const tunnel = new FakeChild();
  const mcp = new FakeChild();
  const lifecycle = new EventEmitter();
  const input = new PassThrough();
  const spawnProcess = vi.fn().mockReturnValueOnce(tunnel).mockReturnValueOnce(mcp);
  const log = vi.fn();
  const options = {
    spawnProcess, checkPort: vi.fn().mockResolvedValue(undefined),
    waitReady: vi.fn().mockResolvedValue(undefined), input, lifecycle,
    entrypoint: "/project/dist/index.js", node: "test-node", env: {}, log,
    ...overrides,
  };
  return { tunnel, mcp, lifecycle, input, spawnProcess, log, options };
}

async function started(spawnProcess: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
}

beforeEach(() => vi.clearAllMocks());

describe("SSH launcher configuration", () => {
  it("uses a loopback-only local forward and noninteractive verified SSH", () => {
    const args = sshArguments(config);
    expect(config).toMatchObject({ sshPort: 22, localPort: 15432, remotePort: 5432 });
    expect(args).toContain("127.0.0.1:15432:127.0.0.1:5432");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("ServerAliveCountMax=3");
    expect(args).toContain("operator@vps.example.com");
    expect(args).not.toContain("-i");
  });

  it("supports an explicit key and ports without shell interpolation", () => {
    const custom = parseTunnelConfig({ host: "192.0.2.1", user: "ops", sshPort: 2222, localPort: 25432, remotePort: 5433, identityFile: "C:/keys/my key" });
    expect(sshArguments(custom)).toEqual(expect.arrayContaining(["2222", "127.0.0.1:25432:127.0.0.1:5433", "IdentitiesOnly=yes", "C:/keys/my key"]));
  });

  it.each([null, [], {}, { host: "-oProxyCommand=bad", user: "ops" }, { host: "vps", user: "ops;bad" }, { host: "vps", user: "ops", localPort: 0 }, { host: "vps", user: "ops", sshPort: 65536 }, { host: "vps", user: "ops", remotePort: "5432" }, { host: "vps", user: "ops", identityFile: " " }])("rejects unsafe or invalid settings without leaking their contents", (value) => {
    expect(() => parseTunnelConfig(value)).toThrow("Invalid SSH tunnel configuration");
  });
});

describe("loopback port checks", () => {
  it("checks and releases an exclusive loopback port", async () => {
    const server = new EventEmitter() as EventEmitter & { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    server.close = vi.fn((done) => done());
    server.listen = vi.fn((_options, done) => done());
    vi.mocked(createServer).mockReturnValue(server as never);
    await assertPortAvailable(15432);
    expect(server.listen.mock.calls[0]?.[0]).toEqual({ host: "127.0.0.1", port: 15432, exclusive: true });
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("refuses an occupied port instead of trusting an unrelated listener", async () => {
    const server = new EventEmitter() as EventEmitter & { listen: ReturnType<typeof vi.fn> };
    server.listen = vi.fn();
    vi.mocked(createServer).mockReturnValue(server as never);
    const result = assertPortAvailable(15432);
    server.emit("error", new Error("sensitive details"));
    await expect(result).rejects.toThrow("already in use");
  });

  it("sanitizes errors releasing the probe port", async () => {
    const server = new EventEmitter() as EventEmitter & { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    server.close = vi.fn((done) => done(new Error("sensitive details")));
    server.listen = vi.fn((_options, done) => done());
    vi.mocked(createServer).mockReturnValue(server as never);
    await expect(assertPortAvailable(15432)).rejects.toThrow("Cannot reserve SSH tunnel local port");
  });
});

describe("PostgreSQL readiness without credentials or SQL", () => {
  function socket() {
    const connection = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), write: vi.fn(), destroy: vi.fn() });
    vi.mocked(createConnection).mockReturnValue(connection as never);
    return connection;
  }

  it.each(["S", "N"])("accepts PostgreSQL SSLRequest response %s", async (response) => {
    const connection = socket();
    const result = probePostgres(15432);
    connection.emit("connect");
    expect(connection.write).toHaveBeenCalledWith(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
    connection.emit("data", Buffer.from(response));
    await expect(result).resolves.toBe(true);
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(createConnection).toHaveBeenCalledWith({ host: "127.0.0.1", port: 15432 });
  });

  it.each(["error", "timeout", "close"])("handles socket %s safely", async (event) => {
    const connection = socket();
    const result = probePostgres(15432);
    connection.emit(event);
    await expect(result).resolves.toBe(false);
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a non-PostgreSQL listener", async () => {
    const connection = socket();
    const result = probePostgres(15432);
    connection.emit("data", Buffer.from("HTTP/1.1"));
    await expect(result).resolves.toBe(false);
  });

  it("cancels an active probe and avoids connections if already cancelled", async () => {
    const controller = new AbortController();
    const connection = socket();
    const result = probePostgres(15432, controller.signal);
    controller.abort();
    await expect(result).resolves.toBe(false);
    expect(connection.destroy).toHaveBeenCalledOnce();
    vi.mocked(createConnection).mockClear();
    await expect(probePostgres(15432, controller.signal)).resolves.toBe(false);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("retries until ready", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await waitForPostgres(15432, new AbortController().signal, { probe, sleep, now: () => 0 });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("bounds startup and honors cancellation", async () => {
    const controller = new AbortController();
    const probe = vi.fn().mockResolvedValue(false);
    let now = 0;
    const sleep = vi.fn(async () => { now += 100; });
    await expect(waitForPostgres(15432, controller.signal, { probe, sleep, now: () => now, timeout: 200 })).rejects.toThrow("did not become ready");
    expect(probe).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(waitForPostgres(15432, controller.signal, { probe })).rejects.toThrow("did not become ready");
  });
});

describe("launcher lifecycle", () => {
  it("waits for readiness, preserves MCP stdio and environment, then stops its tunnel", async () => {
    const state = setup();
    const result = launch(config, state.options);
    await started(state.spawnProcess);
    expect(state.options.waitReady).toHaveBeenCalledWith(15432, expect.any(AbortSignal));
    expect(state.spawnProcess.mock.calls[0]).toEqual(["ssh", sshArguments(config), { stdio: ["ignore", "ignore", "inherit"], windowsHide: true, shell: false }]);
    expect(state.spawnProcess.mock.calls[1]).toEqual(["test-node", ["/project/dist/index.js"], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true, shell: false, env: {} }]);
    state.input.write("protocol-data\n");
    expect(state.mcp.stdin.read().toString()).toBe("protocol-data\n");
    state.mcp.exitCode = 0;
    state.mcp.emit("exit", 0);
    await expect(result).resolves.toBe(0);
    expect(state.tunnel.kill).toHaveBeenCalledOnce();
    expect(state.mcp.kill).not.toHaveBeenCalled();
    expect(state.lifecycle.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not start the MCP before the tunnel is ready", async () => {
    let ready!: () => void;
    const state = setup({ waitReady: () => new Promise<void>((resolve) => { ready = resolve; }) });
    const result = launch(config, state.options);
    await vi.waitFor(() => expect(state.spawnProcess).toHaveBeenCalledTimes(1));
    ready();
    await started(state.spawnProcess);
    state.mcp.exitCode = 7;
    state.mcp.emit("exit", 7);
    await expect(result).resolves.toBe(7);
  });

  it("can verify the tunnel without launching the MCP", async () => {
    const state = setup({ checkOnly: true, entrypoint: undefined });
    await expect(launch(config, state.options)).resolves.toBe(0);
    expect(state.spawnProcess).toHaveBeenCalledOnce();
    expect(state.tunnel.kill).toHaveBeenCalledOnce();
  });

  it("fails closed on an occupied local port without spawning or killing anything", async () => {
    const state = setup({ checkPort: vi.fn().mockRejectedValue(new Error("port occupied")) });
    await expect(launch(config, state.options)).rejects.toThrow("port occupied");
    expect(state.spawnProcess).not.toHaveBeenCalled();
    expect(state.tunnel.kill).not.toHaveBeenCalled();
  });

  it("cleans up when readiness fails", async () => {
    const state = setup({ waitReady: vi.fn().mockRejectedValue(new Error("not ready")) });
    await expect(launch(config, state.options)).rejects.toThrow("not ready");
    expect(state.spawnProcess).toHaveBeenCalledOnce();
    expect(state.tunnel.kill).toHaveBeenCalledOnce();
  });

  it.each(["exit", "error"])("handles SSH %s during startup without a direct fallback", async (event) => {
    const state = setup({ waitReady: () => new Promise(() => {}) });
    const result = launch(config, state.options);
    const assertion = expect(result).rejects.toThrow("SSH tunnel failed to start");
    await vi.waitFor(() => expect(state.spawnProcess).toHaveBeenCalledOnce());
    state.tunnel.exitCode = 255;
    state.tunnel.emit(event, event === "error" ? new Error("private details") : 255);
    await assertion;
    expect(state.spawnProcess).toHaveBeenCalledOnce();
  });

  it("stops the MCP when SSH disconnects", async () => {
    const state = setup();
    const result = launch(config, state.options);
    const assertion = expect(result).rejects.toThrow("SSH tunnel disconnected");
    await started(state.spawnProcess);
    state.tunnel.exitCode = 255;
    state.tunnel.emit("exit", 255);
    await assertion;
    expect(state.mcp.kill).toHaveBeenCalledOnce();
  });

  it.each(["SIGINT", "SIGTERM"])("cleans up both processes on %s", async (signal) => {
    const state = setup();
    const result = launch(config, state.options);
    await started(state.spawnProcess);
    state.lifecycle.emit(signal);
    await expect(result).resolves.toBe(0);
    expect(state.mcp.kill).toHaveBeenCalledOnce();
    expect(state.tunnel.kill).toHaveBeenCalledOnce();
  });

  it("cleans up on MCP client stdin EOF", async () => {
    const state = setup();
    const result = launch(config, state.options);
    await started(state.spawnProcess);
    state.input.end();
    await expect(result).resolves.toBe(0);
    expect(state.tunnel.kill).toHaveBeenCalledOnce();
    expect(state.mcp.kill).toHaveBeenCalledOnce();
  });

  it("handles failure spawning the MCP", async () => {
    const state = setup();
    const result = launch(config, state.options);
    await started(state.spawnProcess);
    state.mcp.emit("error", new Error("private details"));
    await expect(result).resolves.toBe(1);
    expect(state.tunnel.kill).toHaveBeenCalledOnce();
  });

  it("stops safely on a broken MCP input pipe", async () => {
    const state = setup();
    const result = launch(config, state.options);
    await started(state.spawnProcess);
    state.mcp.stdin.emit("error", new Error("EPIPE"));
    await expect(result).resolves.toBe(0);
    expect(state.mcp.kill).toHaveBeenCalledOnce();
    expect(state.tunnel.kill).toHaveBeenCalledOnce();
  });

  it("can cancel before SSH is spawned", async () => {
    let checked!: () => void;
    const state = setup({ checkPort: () => new Promise<void>((resolve) => { checked = resolve; }) });
    const result = launch(config, state.options);
    state.lifecycle.emit("SIGTERM");
    checked();
    await expect(result).resolves.toBe(0);
    expect(state.spawnProcess).not.toHaveBeenCalled();
  });

  it("handles cancellation while waiting for readiness", async () => {
    const state = setup({ waitReady: (_port: number, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
    const result = launch(config, state.options);
    await vi.waitFor(() => expect(state.spawnProcess).toHaveBeenCalledOnce());
    state.lifecycle.emit("SIGTERM");
    await expect(result).resolves.toBe(0);
    expect(state.tunnel.kill).toHaveBeenCalledOnce();
  });

  it("escalates termination only for a child that did not exit", async () => {
    const state = setup();
    state.mcp.kill.mockImplementation(() => { state.mcp.killed = true; return true; });
    const result = launch(config, state.options);
    await started(state.spawnProcess);
    vi.useFakeTimers();
    try {
      state.lifecycle.emit("SIGTERM");
      await expect(result).resolves.toBe(0);
      expect(state.mcp.kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect(state.mcp.kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a missing MCP entrypoint before starting SSH", async () => {
    const state = setup({ entrypoint: undefined });
    await expect(launch(config, state.options)).rejects.toThrow("Missing MCP entrypoint");
    expect(state.spawnProcess).not.toHaveBeenCalled();
  });
});
