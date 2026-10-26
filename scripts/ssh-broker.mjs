import { readFile } from 'node:fs/promises';
import { parseTunnelConfig } from './ssh-launcher.mjs';
import { serveSharedTunnel } from './shared-tunnel.mjs';

try {
  const config = parseTunnelConfig(JSON.parse(await readFile(process.argv[2], 'utf8')));
  await serveSharedTunnel(config);
} catch {
  process.exitCode = 1;
}
