import { readFile } from 'node:fs/promises';
import { parseTunnelConfig } from './ssh-launcher.mjs';
import { acquireSharedTunnel } from './shared-tunnel.mjs';

const SEVEN_DATABASES = ['HOMERO_SE7EN_VILLAGE', 'HOMERO_SE7EN_VILLAGE_DEV'];

/** No config reads or SSH connections until a database using this tunnel is requested. */
export function createLazyTunnel(options) {
  const {
    configPath, databases = SEVEN_DATABASES,
    loadConfig = async (path) => parseTunnelConfig(JSON.parse(await readFile(path, 'utf8'))),
    acquire = acquireSharedTunnel,
  } = options;
  const targets = new Set(databases);
  const controller = new AbortController();
  let lease;
  let pending;
  let closed = false;

  return {
    async beforeDatabase(name) {
      if (!targets.has(name)) return;
      if (closed) throw new Error('SSH tunnel access is shutting down');
      if (lease) return;
      if (!pending) {
        pending = (async () => {
          const config = await loadConfig(configPath);
          if (closed) throw new Error('SSH tunnel access is shutting down');
          const current = await acquire(config, configPath, controller.signal);
          if (closed) { current.release(); throw new Error('SSH tunnel access is shutting down'); }
          lease = current;
          void current.closed.then(() => { if (lease === current) lease = undefined; });
        })().catch(() => {
          // Do not expose raw configuration, credentials or subprocess errors to MCP clients.
          throw new Error('SSH tunnel unavailable for this database; check SSH access and local tunnel configuration');
        }).finally(() => { pending = undefined; });
      }
      await pending;
    },
    async close() {
      closed = true;
      controller.abort();
      lease?.release();
      lease = undefined;
      await pending?.catch(() => {});
    },
  };
}
