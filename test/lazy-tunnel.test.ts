import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyTunnel } from "../scripts/lazy-tunnel.mjs";
import { acquireSharedTunnel } from "../scripts/shared-tunnel.mjs";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../scripts/shared-tunnel.mjs", () => ({ acquireSharedTunnel: vi.fn() }));

const production = "HOMERO_SE7EN_VILLAGE";
const development = "HOMERO_SE7EN_VILLAGE_DEV";
const config = { host: "vps.example.com", user: "operator" };
const configPath = "ignored-test-config.json";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(overrides = {}) {
  const ended = deferred<void>();
  const lease = { closed: ended.promise, release: vi.fn() };
  const loadConfig = vi.fn().mockResolvedValue(config);
  const acquire = vi.fn().mockResolvedValue(lease);
  const tunnel = createLazyTunnel({ configPath, loadConfig, acquire, ...overrides });
  return { tunnel, loadConfig, acquire, lease, ended };
}

afterEach(() => { vi.clearAllMocks(); });

describe("per-database lazy SSH", () => {
  it("does not read configuration or start SSH at construction, for other projects, or on unused shutdown", async () => {
    const { tunnel, loadConfig, acquire } = setup();
    for (const name of ["TEMPE_QUINTAS", "GARIN_SHOWROOM", "HOMERO_ZANDRA", "HOMERO_PAMELA", "BYSONTE_BOT"]) {
      await tunnel.beforeDatabase(name);
    }
    await tunnel.close();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("shares one pending startup and lease across production and development", async () => {
    const waiting = deferred<unknown>();
    const acquire = vi.fn(() => waiting.promise);
    const { tunnel, loadConfig, lease } = setup({ acquire });
    const first = tunnel.beforeDatabase(production);
    const second = tunnel.beforeDatabase(development);
    await Promise.resolve();
    waiting.resolve(lease);
    await Promise.all([first, second]);
    await tunnel.beforeDatabase(production);
    expect(loadConfig).toHaveBeenCalledOnce();
    expect(loadConfig).toHaveBeenCalledWith(configPath);
    expect(acquire).toHaveBeenCalledOnce();
    await tunnel.close();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it.each(["configuration", "ssh"])("isolates a %s failure, sanitizes it, and retries only on a later Seven request", async (failure) => {
    const { tunnel, loadConfig, acquire } = setup();
    (failure === "configuration" ? loadConfig : acquire).mockRejectedValueOnce(new Error("password=private-detail"));
    await expect(tunnel.beforeDatabase(production)).rejects.toThrow("SSH tunnel unavailable for this database");
    await tunnel.beforeDatabase("TEMPE_QUINTAS");
    await tunnel.beforeDatabase(development);
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenCalledTimes(failure === "configuration" ? 1 : 2);
    await tunnel.close();
  });

  it("does not make another project wait while Seven is still connecting", async () => {
    const waiting = deferred<unknown>();
    const { tunnel, lease } = setup({ acquire: vi.fn(() => waiting.promise) });
    const seven = tunnel.beforeDatabase(production);
    await expect(tunnel.beforeDatabase("OTHER_PROJECT")).resolves.toBeUndefined();
    waiting.resolve(lease);
    await seven;
    await tunnel.close();
  });

  it("keeps the MCP usable after tunnel loss and reacquires on the next Seven operation", async () => {
    const { tunnel, acquire, ended } = setup();
    await tunnel.beforeDatabase(production);
    ended.resolve();
    await Promise.resolve();
    await tunnel.beforeDatabase("OTHER_PROJECT");
    expect(acquire).toHaveBeenCalledOnce();
    const next = { closed: new Promise(() => {}), release: vi.fn() };
    acquire.mockResolvedValueOnce(next);
    await tunnel.beforeDatabase(development);
    expect(acquire).toHaveBeenCalledTimes(2);
    await tunnel.close();
    expect(next.release).toHaveBeenCalledOnce();
  });

  it("aborts pending acquisition at shutdown without leaking or automatically retrying it", async () => {
    const acquire = vi.fn((_config, _path, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const { tunnel } = setup({ acquire });
    const seven = expect(tunnel.beforeDatabase(production)).rejects.toThrow("unavailable");
    await Promise.resolve();
    await tunnel.close();
    await seven;
    await expect(tunnel.beforeDatabase(production)).rejects.toThrow("shutting down");
    await tunnel.beforeDatabase("OTHER_PROJECT");
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("does not acquire SSH if shutdown happened while configuration was loading", async () => {
    const loading = deferred<unknown>();
    const { tunnel, acquire } = setup({ loadConfig: () => loading.promise });
    const seven = expect(tunnel.beforeDatabase(production)).rejects.toThrow("unavailable");
    const closing = tunnel.close();
    loading.resolve(config);
    await Promise.all([seven, closing]);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("releases a late lease if acquisition races shutdown", async () => {
    const waiting = deferred<unknown>();
    const { tunnel, lease } = setup({ acquire: () => waiting.promise });
    const seven = expect(tunnel.beforeDatabase(production)).rejects.toThrow("unavailable");
    await Promise.resolve();
    const closing = tunnel.close();
    waiting.resolve(lease);
    await Promise.all([seven, closing]);
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("uses the config parser and shared coordinator by default, without exposing the config", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(config));
    const lease = { closed: new Promise(() => {}), release: vi.fn() };
    vi.mocked(acquireSharedTunnel).mockResolvedValueOnce(lease);
    const tunnel = createLazyTunnel({ configPath });
    await tunnel.beforeDatabase(production);
    expect(readFile).toHaveBeenCalledWith(configPath, "utf8");
    expect(acquireSharedTunnel).toHaveBeenCalledWith(expect.objectContaining({ ...config, localPort: 15432 }), configPath, expect.any(AbortSignal));
    await tunnel.close();
  });

  it("rejects malformed config only when Seven is requested", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("not JSON");
    const tunnel = createLazyTunnel({ configPath });
    await tunnel.beforeDatabase("OTHER_PROJECT");
    await expect(tunnel.beforeDatabase(production)).rejects.toThrow("unavailable");
    await tunnel.close();
  });
});
