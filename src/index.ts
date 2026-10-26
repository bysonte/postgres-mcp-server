#!/usr/bin/env node

import { logger } from "./lib/logger.js";
import { run } from "./runtime.js";
export { run } from "./runtime.js";

run().catch(() => {
  logger.error("Startup failed: check PostgreSQL configuration");
  process.exit(1);
});
