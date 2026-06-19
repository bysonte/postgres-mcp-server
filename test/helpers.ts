import type pg from "pg";

export interface QueryCall {
  text: string;
  params?: readonly unknown[];
}

export class FakeClient {
  readonly calls: QueryCall[] = [];
  released = false;
  failOn?: string;

  constructor(private readonly rows: readonly Record<string, unknown>[] = []) {}

  async query(text: string, params?: readonly unknown[]): Promise<pg.QueryResult> {
    this.calls.push({ text, params });
    if (this.failOn && text.includes(this.failOn)) throw new Error("db password=secret failed");
    return {
      command: text.split(/\s+/, 1)[0]?.toUpperCase() ?? "QUERY",
      rowCount: this.rows.length,
      oid: 0,
      rows: [...this.rows],
      fields: [{ name: "id", tableID: 0, columnID: 0, dataTypeID: 23, dataTypeSize: 4, dataTypeModifier: -1, format: "text" }],
    };
  }

  release(): void {
    this.released = true;
  }
}

export class FakePool {
  constructor(readonly client: FakeClient = new FakeClient()) {}

  async connect(): Promise<FakeClient> {
    return this.client;
  }
}

export function asPool(pool: FakePool): pg.Pool {
  return pool as unknown as pg.Pool;
}

export function asClient(client: FakeClient): pg.PoolClient {
  return client as unknown as pg.PoolClient;
}
