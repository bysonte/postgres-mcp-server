import { describe, expect, it } from "vitest";
import { describeTable, listSchemas, listTables } from "../src/lib/introspection.js";
import { asPool, FakeClient, FakePool } from "./helpers.js";

describe("introspection", () => {
  it("lista esquemas sin parámetros de usuario", async () => {
    const client = new FakeClient([{ schema_name: "public" }]);
    const result = await listSchemas(asPool(new FakePool(client)));
    expect(result.isError).toBeUndefined();
    expect(client.calls[0]?.text).toContain("information_schema.schemata");
  });

  it("lista tablas con schema parametrizado", async () => {
    const client = new FakeClient([{ table_name: "users" }]);
    const payload = "public'; DROP TABLE users; --";
    await listTables(asPool(new FakePool(client)), payload);
    expect(client.calls[0]?.params).toEqual([payload]);
    expect(client.calls[0]?.text).not.toContain(payload);
  });

  it("lista tablas sin schema usando null", async () => {
    const client = new FakeClient([]);
    await listTables(asPool(new FakePool(client)));
    expect(client.calls[0]?.params).toEqual([null]);
  });

  it("describe tabla con schema y tabla parametrizados en todas las consultas", async () => {
    const client = new FakeClient();
    await describeTable(asPool(new FakePool(client)), "public", "users");
    expect(client.calls).toHaveLength(3);
    expect(client.calls.every((call) => JSON.stringify(call.params) === JSON.stringify(["public", "users"]))).toBe(true);
    expect(client.calls.map((call) => call.text).join("\n")).not.toContain("public.users");
  });

  it("convierte errores DB a MCP error", async () => {
    const client = new FakeClient();
    client.failOn = "information_schema.tables";
    const result = await listTables(asPool(new FakePool(client)), "public");
    expect(result.isError).toBe(true);
  });

  it("convierte errores de esquemas y descripción", async () => {
    const schemaClient = new FakeClient();
    schemaClient.failOn = "information_schema.schemata";
    expect((await listSchemas(asPool(new FakePool(schemaClient)))).isError).toBe(true);

    const describeClient = new FakeClient();
    describeClient.failOn = "information_schema.columns";
    expect((await describeTable(asPool(new FakePool(describeClient)), "public", "users")).isError).toBe(true);
  });
});
