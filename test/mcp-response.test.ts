import { describe, expect, it } from "vitest";
import { errorResponse, jsonResponse, textResponse } from "../src/lib/mcp-response.js";
import { redactSecrets } from "../src/lib/logger.js";

describe("mcp-response", () => {
  it("crea texto simple", () => {
    expect(textResponse("ok")).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("crea json indentado", () => {
    expect(jsonResponse({ a: 1 }).content[0]?.text).toContain('"a": 1');
  });

  it("marca errores y oculta secretos", () => {
    const result = errorResponse(new Error("postgresql://u:p@host/db password=abc"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("***");
    expect(result.content[0]?.text).not.toContain("abc");
  });

  it("redacta URLs y tokens", () => {
    expect(redactSecrets("postgres://user:secret@localhost/db token=abc")).toBe("postgresql://user:***@localhost/db token=***");
  });
});
