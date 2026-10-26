#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launch, parseTunnelConfig } from './ssh-launcher.mjs';
import { acquireSharedTunnel } from './shared-tunnel.mjs';
import { createLazyTunnel } from './lazy-tunnel.mjs';

try {
  const configPath = process.env.POSTGRES_SSH_CONFIG_PATH ?? fileURLToPath(new URL('../ssh-tunnel.json', import.meta.url));
  if (process.argv.includes('--check')) {
    const config = parseTunnelConfig(JSON.parse(await readFile(configPath, 'utf8')));
    process.exitCode = await launch(config, {
      checkOnly: true,
      acquireTunnel: (settings, signal) => acquireSharedTunnel(settings, configPath, signal),
    });
  } else {
    process.env.POSTGRES_ENV_PATH ??= fileURLToPath(new URL('../.env', import.meta.url));
    const tunnel = createLazyTunnel({ configPath });
    const { run } = await import('../dist/runtime.js');
    await run(process.argv.slice(2), { beforeDatabase: tunnel.beforeDatabase, beforeShutdown: tunnel.close });
  }
} catch {
  process.stderr.write('Postgres MCP launcher failed. Check the local configuration, build and SSH settings (for --check).\n');
  process.exitCode = 1;
}
