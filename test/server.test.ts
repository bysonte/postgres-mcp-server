import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import { DatabaseRegistry } from "../src/lib/database-registry.js";
import { asPool, FakePool } from "./helpers.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("server", () => {
  it("registra todas las tools con registerTool", () => {
    const spy = vi.spyOn(McpServer.prototype, "registerTool");
    createServer({ name: "postgres-mcp-server", version: "1.0.0" }, { registry: new DatabaseRegistry({ logger }), logger });
    const names = spy.mock.calls.map((call) => call[0]);
    expect(names).toEqual([
      "list_databases",
      "execute_query",
      "execute_dml_ddl_dcl_tcl",
      "execute_maintenance",
      "execute_commit",
      "execute_rollback",
      "list_schemas",
      "list_tables",
      "describe_table",
    ]);
    expect(spy.mock.calls[0]?.[1]).toHaveProperty("inputSchema");
    spy.mockRestore();
  });

  it("despacha por database via MCP, oculta URLs y aplica permisos tras recarga", async () => {
    const directory = await mkdtemp(join(tmpdir(), "postgres-server-"));
    const envPath = join(directory, ".env");
    const content = (allowed: boolean) => `POSTGRES_DB_A_URL=postgresql://user:secret@host/a\nPOSTGRES_DB_A_ENABLE_WRITE=${allowed}\nPOSTGRES_DB_A_ENABLE_TRANSACTION_MONITOR=false\nPOSTGRES_DB_B_URL=postgresql://other:secret@host/b\nPOSTGRES_DB_B_ENABLE_TRANSACTION_MONITOR=false\n`;
    const pools: FakePool[] = [];
    const registry = new DatabaseRegistry({ envPath, env: {}, logger, poolFactory: () => {
      const pool = new FakePool();
      pools.push(pool);
      return asPool(pool);
    } });
    const server = createServer({ name: "postgres-mcp-server", version: "1.0.0" }, { registry, logger });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await writeFile(envPath, content(false));
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools).toHaveLength(9);
      const listed = await client.callTool({ name: "list_databases", arguments: {} });
      const listedText = (listed.content as Array<{ text: string }>)[0]?.text ?? "{}";
      expect(JSON.parse(listedText).databases[0].name).toBe("A");
      expect(JSON.stringify(listed)).not.toContain("secret");
      const firstPage = await client.callTool({ name: "list_databases", arguments: { limit: 1 } });
      expect(JSON.parse((firstPage.content as Array<{ text: string }>)[0]?.text ?? "{}")).toMatchObject({
        databases: [{ name: "A" }], has_more: true, next_offset: 1, total_count: 2,
      });
      const secondPage = await client.callTool({ name: "list_databases", arguments: { limit: 1, offset: 1 } });
      expect(JSON.parse((secondPage.content as Array<{ text: string }>)[0]?.text ?? "{}")).toMatchObject({
        databases: [{ name: "B" }], has_more: false, next_offset: null,
      });
      const read = await client.callTool({ name: "execute_query", arguments: { database: "B", sql: "SELECT 1" } });
      expect(read.isError).toBeUndefined();
      expect(pools[1]?.client.calls.map((call) => call.text)).toContain("SELECT 1");
      expect((await client.callTool({ name: "execute_dml_ddl_dcl_tcl", arguments: { database: "A", sql: "INSERT INTO x VALUES(1)" } })).isError).toBe(true);
      await writeFile(envPath, content(true));
      const pending = await client.callTool({ name: "execute_dml_ddl_dcl_tcl", arguments: { database: "A", sql: "INSERT INTO x VALUES(1)" } });
      expect(pending.isError).toBeUndefined();
      const contentItems = pending.content as Array<{ type: string; text: string }>;
      const id = JSON.parse(contentItems[0]?.text ?? "{}").transaction_id as string;
      expect((await client.callTool({ name: "execute_commit", arguments: { database: "B", transaction_id: id } })).isError).toBe(true);
      await writeFile(envPath, content(false));
      expect((await client.callTool({ name: "execute_commit", arguments: { database: "A", transaction_id: id } })).isError).toBe(true);
      expect(pools[2]?.client.calls.map((call) => call.text)).toContain("ROLLBACK");
    } finally {
      await client.close();
      await server.close();
      await registry.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
