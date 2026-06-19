import type { ToolResponse } from "./types.js";
import { redactSecrets } from "./logger.js";
import { safeErrorMessage } from "./utils.js";

export function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

export function jsonResponse(data: unknown): ToolResponse {
  return textResponse(JSON.stringify(data, null, 2));
}

export function errorResponse(error: unknown, prefix = "Error"): ToolResponse {
  const message = redactSecrets(`${prefix}: ${safeErrorMessage(error)}`);
  return { content: [{ type: "text", text: message }], isError: true };
}
