export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return "";
  if (meta instanceof Error) return ` ${meta.message}`;
  if (typeof meta === "string") return ` ${meta}`;
  return ` ${JSON.stringify(meta)}`;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/([^:\s/]+):([^@\s]+)@/gi, "postgresql://$1:***@")
    .replace(/(password|token|secret)=([^\s&]+)/gi, "$1=***")
    .replace(/(POSTGRES_PASSWORD|PGPASSWORD)\s*[:=]\s*([^\s]+)/gi, "$1=***");
}

function write(level: string, message: string, meta?: unknown): void {
  const line = `[${level}] ${redactSecrets(message + formatMeta(meta))}\n`;
  process.stderr.write(line);
}

export const logger: Logger = {
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
};
