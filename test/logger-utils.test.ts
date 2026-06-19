import { describe, expect, it, vi } from "vitest";
import { logger, redactSecrets } from "../src/lib/logger.js";
import { safeErrorMessage, safelyReleaseClient } from "../src/lib/utils.js";
import { asClient, FakeClient } from "./helpers.js";

describe("logger and utils", () => {
  it("escribe solo stderr con niveles", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logger.info("hello");
    logger.warn("warn", { code: 1 });
    logger.error("bad", new Error("boom"));
    expect(spy).toHaveBeenCalledTimes(3);
    expect(String(spy.mock.calls[0]?.[0])).toContain("[info] hello");
    spy.mockRestore();
  });

  it("redacta password env style", () => {
    expect(redactSecrets("POSTGRES_PASSWORD: abc")).toBe("POSTGRES_PASSWORD=***");
  });

  it("convierte errores desconocidos", () => {
    expect(safeErrorMessage("x")).toBe("x");
    expect(safeErrorMessage({})).toBe("Unexpected error");
  });

  it("captura error de release", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = asClient(new FakeClient());
    client.release = () => { throw new Error("already released"); };
    safelyReleaseClient(client);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
