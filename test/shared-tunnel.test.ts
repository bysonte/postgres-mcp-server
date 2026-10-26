import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTunnelConfig } from "../scripts/ssh-launcher.mjs";
import { acquireSharedTunnel, connectLease, endpoint, fingerprint, serveSharedTunnel } from "../scripts/shared-tunnel.mjs";

vi.mock("node:net", () => ({ createConnection: vi.fn(), createServer: vi.fn() }));
const config = parseTunnelConfig({ host: "vps.example.com", user: "operator" });

class Socket extends EventEmitter {
  closed = false;
  setTimeout = vi.fn();
  write = vi.fn();
  destroy = vi.fn(() => {
    if (!this.closed) { this.closed = true; this.emit("close"); }
  });
}

function socket() {
  const client = new Socket();
  vi.mocked(createConnection).mockReturnValue(client as never);
  return client;
}

function brokerSetup(overrides = {}) {
  let accept!: (client: Socket) => void;
  let closeTunnel!: () => void;
  const lease = { release: vi.fn(), closed: new Promise<void>((resolve) => { closeTunnel = resolve; }) };
  const server = Object.assign(new EventEmitter(), { listen: vi.fn((_path, ready) => ready()), close: vi.fn((done) => done()) });
  const lifecycle = new EventEmitter();
  const open = vi.fn().mockResolvedValue(lease);
  const makeServer = vi.fn((callback) => { accept = callback; return server; });
  const options = { open, makeServer, lifecycle, ...overrides };
  return { lease, server, lifecycle, open, options, accept: (client: Socket) => accept(client), closeTunnel: () => closeTunnel() };
}

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("shared tunnel identity", () => {
  it("shares one endpoint per local port, but rejects a different remote destination", () => {
    const different = parseTunnelConfig({ host: "other.example.com", user: "operator" });
    expect(endpoint(config)).toBe(endpoint(different));
    expect(fingerprint(config)).not.toBe(fingerprint(different));
    expect(endpoint(config)).not.toBe(endpoint({ ...config, localPort: 25432 }));
    expect(endpoint(config)).not.toContain(config.host);
  });
});

describe("client leases", () => {
  it("accepts a matching fragmented readiness response and keeps the lease until released", async () => {
    const client = socket();
    const result = connectLease(config, new AbortController().signal);
    client.emit("data", Buffer.from("ready:"));
    client.emit("data", Buffer.from(`${fingerprint(config)}\n`));
    const lease = await result;
    expect(client.setTimeout).toHaveBeenLastCalledWith(0);
    client.emit("data", Buffer.from("ignored"));
    lease.release();
    await expect(lease.closed).resolves.toBeUndefined();
  });

  it.each(["ready:wrong\n", "x".repeat(129)])("rejects a mismatched or oversized broker response", async (response) => {
    const client = socket();
    const result = connectLease(config);
    client.emit("data", Buffer.from(response));
    await expect(result).rejects.toThrow(/response|mismatch/);
    expect(client.destroy).toHaveBeenCalled();
  });

  it.each(["ENOENT", "ECONNREFUSED", "EACCES"])("classifies broker connection error %s without exposing details", async (code) => {
    const client = socket();
    const result = connectLease(config);
    client.emit("error", Object.assign(new Error("private detail"), { code }));
    await expect(result).rejects.toMatchObject({ message: "SSH tunnel broker unavailable", retryable: code !== "EACCES" });
  });

  it.each(["timeout", "close"])("handles %s before readiness", async (event) => {
    const client = socket();
    const result = connectLease(config);
    client.emit(event);
    await expect(result).rejects.toThrow(/timed out|closed before/);
  });

  it("cancels a pending connection and closes an established lease on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const first = socket();
    await expect(connectLease(config, controller.signal)).rejects.toThrow("cancelled");
    expect(first.destroy).toHaveBeenCalled();
    const active = new AbortController();
    const second = socket();
    const result = connectLease(config, active.signal);
    second.emit("data", Buffer.from(`ready:${fingerprint(config)}\n`));
    const lease = await result;
    active.abort();
    await expect(lease.closed).resolves.toBeUndefined();
  });
});

describe("shared tunnel acquisition", () => {
  it("reuses an existing coordinator without spawning", async () => {
    const lease = { closed: new Promise(() => {}), release: vi.fn() };
    const spawnProcess = vi.fn();
    await expect(acquireSharedTunnel(config, "/config.json", new AbortController().signal, { connect: vi.fn().mockResolvedValue(lease), spawnProcess })).resolves.toBe(lease);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("starts at most one detached broker and retries local connection", async () => {
    const broker = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const unavailable = Object.assign(new Error("missing"), { retryable: true });
    const lease = { release: vi.fn(), closed: new Promise(() => {}) };
    const connect = vi.fn().mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable).mockResolvedValue(lease);
    const spawnProcess = vi.fn().mockReturnValue(broker);
    await expect(acquireSharedTunnel(config, "/config.json", new AbortController().signal, { connect, spawnProcess, sleep: vi.fn().mockResolvedValue(undefined) })).resolves.toBe(lease);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[1][1]).toBe("/config.json");
    expect(spawnProcess.mock.calls[0]?.[2]).toEqual({ detached: true, stdio: "ignore", windowsHide: true, shell: false });
    expect(broker.unref).toHaveBeenCalledOnce();
  });

  it("fails immediately for a configuration mismatch", async () => {
    const spawnProcess = vi.fn();
    await expect(acquireSharedTunnel(config, "/config.json", new AbortController().signal, { connect: vi.fn().mockRejectedValue(new Error("mismatch")), spawnProcess })).rejects.toThrow("mismatch");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("reports broker spawn failure", async () => {
    const broker = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const unavailable = Object.assign(new Error("missing"), { retryable: true });
    const spawnProcess = vi.fn().mockReturnValue(broker);
    const sleep = vi.fn(async () => { broker.emit("error", new Error("private detail")); });
    await expect(acquireSharedTunnel(config, "/config.json", new AbortController().signal, { connect: vi.fn().mockRejectedValue(unavailable), spawnProcess, sleep })).rejects.toThrow("Could not start");
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("bounds retries and handles cancellation", async () => {
    const broker = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const unavailable = Object.assign(new Error("missing"), { retryable: true });
    const connect = vi.fn().mockRejectedValue(unavailable);
    let now = 0;
    await expect(acquireSharedTunnel(config, "/config.json", new AbortController().signal, { connect, spawnProcess: vi.fn().mockReturnValue(broker), now: () => now, sleep: async () => { now += 25000; } })).rejects.toThrow("did not become ready");
    const controller = new AbortController();
    controller.abort();
    connect.mockClear();
    await expect(acquireSharedTunnel(config, "/config.json", controller.signal, { connect })).rejects.toThrow("did not become ready");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("shared broker lifecycle", () => {
  it("keeps SSH open while any client is active and closes it after the last disconnect", async () => {
    const state = brokerSetup();
    const result = serveSharedTunnel(config, state.options);
    await vi.waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    const first = new Socket();
    const second = new Socket();
    state.accept(first);
    state.accept(second);
    expect(first.write).toHaveBeenCalledWith(`ready:${fingerprint(config)}\n`);
    expect(second.write).toHaveBeenCalledWith(`ready:${fingerprint(config)}\n`);
    first.emit("data", Buffer.from("ignored"));
    vi.useFakeTimers();
    first.destroy();
    vi.advanceTimersByTime(1000);
    expect(state.lease.release).not.toHaveBeenCalled();
    second.destroy();
    vi.advanceTimersByTime(1000);
    await result;
    expect(state.lease.release).toHaveBeenCalledOnce();
    expect(state.server.close).toHaveBeenCalledOnce();
    expect(state.lifecycle.listenerCount("SIGTERM")).toBe(0);
  });

  it("waits for SSH readiness before announcing to early clients", async () => {
    let ready!: (lease: unknown) => void;
    const open = vi.fn(() => new Promise((resolve) => { ready = resolve; }));
    const state = brokerSetup({ open });
    const result = serveSharedTunnel(config, state.options);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const client = new Socket();
    state.accept(client);
    expect(client.write).not.toHaveBeenCalled();
    ready(state.lease);
    await vi.waitFor(() => expect(client.write).toHaveBeenCalledOnce());
    state.closeTunnel();
    await result;
    expect(client.destroy).toHaveBeenCalled();
  });

  it("cleans up all clients after SSH exits", async () => {
    const state = brokerSetup();
    const result = serveSharedTunnel(config, state.options);
    await vi.waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    const client = new Socket();
    state.accept(client);
    state.closeTunnel();
    await result;
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(state.lease.release).toHaveBeenCalledOnce();
  });

  it.each(["SIGINT", "SIGTERM"])("cleans up after %s", async (signal) => {
    const state = brokerSetup();
    const result = serveSharedTunnel(config, state.options);
    await vi.waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    state.lifecycle.emit(signal);
    await result;
    expect(state.lease.release).toHaveBeenCalledOnce();
  });

  it("cleans up if SSH startup fails", async () => {
    const state = brokerSetup({ open: vi.fn().mockRejectedValue(new Error("SSH failed")) });
    await expect(serveSharedTunnel(config, state.options)).rejects.toThrow("SSH failed");
    expect(state.server.close).toHaveBeenCalledOnce();
  });

  it("does not start SSH when another broker owns the pipe", async () => {
    const state = brokerSetup();
    state.server.listen.mockImplementation(() => { queueMicrotask(() => state.server.emit("error", new Error("EADDRINUSE"))); });
    await expect(serveSharedTunnel(config, state.options)).rejects.toThrow("EADDRINUSE");
    expect(state.open).not.toHaveBeenCalled();
  });

  it("closes a tunnel that finishes starting after shutdown", async () => {
    let ready!: (lease: unknown) => void;
    const open = vi.fn(() => new Promise((resolve) => { ready = resolve; }));
    const state = brokerSetup({ open });
    const result = serveSharedTunnel(config, state.options);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    state.lifecycle.emit("SIGTERM");
    ready(state.lease);
    await result;
    expect(state.lease.release).toHaveBeenCalledOnce();
  });

  it("expires an unused coordinator and handles client errors", async () => {
    const state = brokerSetup();
    vi.useFakeTimers();
    const result = serveSharedTunnel(config, state.options);
    await vi.advanceTimersByTimeAsync(0);
    const client = new Socket();
    state.accept(client);
    client.emit("error", new Error("pipe closed"));
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(client.destroy).toHaveBeenCalled();
    const late = new Socket();
    state.accept(late);
    expect(late.destroy).toHaveBeenCalled();
  });
});
