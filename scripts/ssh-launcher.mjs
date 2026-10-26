import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export function parseTunnelConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid SSH tunnel configuration');
  }
  const { host, user, sshPort = 22, localPort = 15432, remotePort = 5432, identityFile } = value;
  const isPort = (port) => Number.isInteger(port) && port > 0 && port <= 65535;
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)
    || typeof user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user)
    || ![sshPort, localPort, remotePort].every(isPort)
    || (identityFile !== undefined && (typeof identityFile !== 'string' || !identityFile.trim()))) {
    throw new Error('Invalid SSH tunnel configuration');
  }
  return { host, user, sshPort, localPort, remotePort, identityFile };
}

export function sshArguments(config) {
  return [
    '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-p', String(config.sshPort),
    ...(config.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', config.identityFile] : []),
    '-L', `127.0.0.1:${config.localPort}:127.0.0.1:${config.remotePort}`,
    `${config.user}@${config.host}`,
  ];
}

export function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('SSH tunnel local port is already in use; close the other launcher or choose another port')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => error ? reject(new Error('Cannot reserve SSH tunnel local port')) : resolve());
    });
  });
}

// PostgreSQL SSLRequest probes the forwarded server without authentication or SQL.
export function probePostgres(port, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(500);
    socket.once('connect', () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
    socket.once('data', (data) => finish(data.length === 1 && (data[0] === 83 || data[0] === 78)));
    socket.once('error', abort);
    socket.once('timeout', abort);
    socket.once('close', abort);
  });
}

export async function waitForPostgres(port, signal, dependencies = {}) {
  const { probe = probePostgres, sleep = delay, now = Date.now, timeout = 15000 } = dependencies;
  const deadline = now() + timeout;
  while (!signal.aborted && now() < deadline) {
    if (await probe(port, signal)) return;
    await sleep(100, undefined, { signal });
  }
  throw new Error('SSH tunnel did not become ready; check SSH access and PostgreSQL');
}

function exited(child, type) {
  return new Promise((resolve) => {
    child.once('error', () => resolve({ type, code: 1 }));
    child.once('exit', (code) => resolve({ type, code: code ?? 1 }));
  });
}

function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    force.unref();
    child.once('exit', () => clearTimeout(force));
    child.kill();
  }
}

export async function openTunnel(config, options = {}) {
  const { spawnProcess = spawn, checkPort = assertPortAvailable, waitReady = waitForPostgres, sshCommand = 'ssh', signal } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let tunnel;
  let ready = false;
  try {
    await checkPort(config.localPort);
    if (controller.signal.aborted) throw new Error('SSH tunnel startup cancelled');
    tunnel = spawnProcess(sshCommand, sshArguments(config), { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true, shell: false });
    const closed = exited(tunnel, 'ssh');
    const startup = await Promise.race([
      waitReady(config.localPort, controller.signal).then(() => ({ type: 'ready' })), closed,
      new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve({ type: 'stop' }), { once: true })),
    ]);
    if (startup.type !== 'ready') throw new Error('SSH tunnel failed to start; check SSH key access and known_hosts');
    ready = true;
    return { closed, release: () => stop(tunnel) };
  } finally {
    signal?.removeEventListener('abort', abort);
    controller.abort();
    if (!ready) stop(tunnel);
  }
}

export async function launch(config, options = {}) {
  const {
    spawnProcess = spawn, checkPort = assertPortAvailable, waitReady = waitForPostgres,
    input = process.stdin, lifecycle = process, node = process.execPath,
    sshCommand = 'ssh', entrypoint, env = process.env,
    checkOnly = false, log = (message) => process.stderr.write(`${message}\n`),
    acquireTunnel = (settings, signal) => openTunnel(settings, { spawnProcess, checkPort, waitReady, sshCommand, signal }),
  } = options;
  if (!checkOnly && !entrypoint) throw new Error('Missing MCP entrypoint');
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  const stopped = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve({ type: 'stop' }), { once: true }));
  let lease;
  let mcp;
  lifecycle.once('SIGINT', shutdown);
  lifecycle.once('SIGTERM', shutdown);
  input.once('end', shutdown);
  input.once('error', shutdown);
  try {
    lease = await acquireTunnel(config, controller.signal);
    if (controller.signal.aborted) return 0;
    const tunnelEnded = lease.closed.then(() => ({ type: 'ssh' }));
    log('SSH tunnel ready (loopback only)');
    if (checkOnly) return 0;
    mcp = spawnProcess(node, [entrypoint], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, shell: false, env });
    const mcpEnded = exited(mcp, 'mcp');
    mcp.stdin.on('error', shutdown);
    input.pipe(mcp.stdin);
    const result = await Promise.race([mcpEnded, tunnelEnded, stopped]);
    if (result.type === 'ssh') throw new Error('SSH tunnel disconnected; reconnect the MCP to reopen it');
    return result.type === 'stop' ? 0 : result.code;
  } catch (error) {
    if (controller.signal.aborted) return 0;
    throw error;
  } finally {
    controller.abort();
    lifecycle.removeListener('SIGINT', shutdown);
    lifecycle.removeListener('SIGTERM', shutdown);
    input.removeListener('end', shutdown);
    input.removeListener('error', shutdown);
    if (mcp) input.unpipe(mcp.stdin);
    input.destroy();
    stop(mcp);
    lease?.release();
  }
}
