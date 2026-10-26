import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openTunnel } from './ssh-launcher.mjs';

export function fingerprint(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export function endpoint(config) {
  const id = createHash('sha256').update(`${homedir()}:${config.localPort}`).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\postgres-mcp-ssh-${id}` : join(tmpdir(), `postgres-mcp-ssh-${id}.sock`);
}

export function connectLease(config, signal) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint(config) });
    let ready = false;
    let settled = false;
    let text = '';
    let close;
    const closed = new Promise((done) => { close = done; });
    const abort = () => fail(new Error('SSH tunnel connection cancelled'));
    const fail = (error) => {
      if (!settled) { settled = true; reject(error); }
      socket.destroy();
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(20000);
    socket.on('error', (error) => {
      const unavailable = ['ENOENT', 'ECONNREFUSED'].includes(error.code);
      fail(Object.assign(new Error('SSH tunnel broker unavailable'), { retryable: unavailable }));
    });
    socket.once('timeout', () => fail(new Error('SSH tunnel broker timed out')));
    socket.once('close', () => {
      signal?.removeEventListener('abort', abort);
      close();
      if (!ready) fail(new Error('SSH tunnel broker closed before becoming ready'));
    });
    socket.on('data', (data) => {
      if (ready) return;
      text += data.toString('utf8');
      if (text.length > 128) { fail(new Error('Invalid SSH tunnel broker response')); return; }
      if (!text.includes('\n')) return;
      if (text !== `ready:${fingerprint(config)}\n`) { fail(new Error('SSH tunnel broker configuration mismatch')); return; }
      ready = true;
      settled = true;
      socket.setTimeout(0);
      resolve({ closed, release: () => socket.destroy() });
    });
    if (signal?.aborted) abort();
  });
}

export async function acquireSharedTunnel(config, configPath, signal, options = {}) {
  const { connect = connectLease, spawnProcess = spawn, sleep = delay, now = Date.now } = options;
  const deadline = now() + 25000;
  let started = false;
  let spawnFailed = false;
  while (!signal.aborted && now() < deadline) {
    try {
      return await connect(config, signal);
    } catch (error) {
      if (!error.retryable) throw error;
      if (!started) {
        started = true;
        const broker = spawnProcess(process.execPath, [fileURLToPath(new URL('./ssh-broker.mjs', import.meta.url)), configPath], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
        broker.once('error', () => { spawnFailed = true; });
        broker.unref();
      }
      if (spawnFailed) throw new Error('Could not start SSH tunnel broker');
      await sleep(100, undefined, { signal });
    }
  }
  throw new Error('SSH tunnel broker did not become ready');
}

export async function serveSharedTunnel(config, options = {}) {
  const { open = openTunnel, makeServer = createServer, lifecycle = process, idleMs = 1000 } = options;
  const controller = new AbortController();
  const clients = new Set();
  let lease;
  let ready = false;
  let ending = false;
  let timer;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const shutdown = () => {
    if (ending) return;
    ending = true;
    clearTimeout(timer);
    controller.abort();
    for (const client of clients) client.destroy();
    lease?.release();
    server.close(() => {});
    finish();
  };
  const idle = (ms) => { clearTimeout(timer); timer = setTimeout(shutdown, ms); };
  const announce = (client) => client.write(`ready:${fingerprint(config)}\n`);
  const server = makeServer((client) => {
    if (ending) { client.destroy(); return; }
    clients.add(client);
    clearTimeout(timer);
    client.on('error', () => client.destroy());
    client.on('data', () => {});
    client.once('close', () => {
      clients.delete(client);
      if (clients.size === 0 && !ending) idle(idleMs);
    });
    if (ready) announce(client);
  });
  lifecycle.once('SIGINT', shutdown);
  lifecycle.once('SIGTERM', shutdown);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint(config), resolve);
    });
    server.on('error', shutdown);
    idle(25000);
    lease = await open(config, { signal: controller.signal });
    if (ending) { lease.release(); return; }
    ready = true;
    for (const client of clients) announce(client);
    void lease.closed.then(shutdown);
    await done;
  } finally {
    shutdown();
    lifecycle.removeListener('SIGINT', shutdown);
    lifecycle.removeListener('SIGTERM', shutdown);
  }
}
