# postgres-mcp-server

Servidor MCP local para PostgreSQL. Está pensado para OpenCode y clientes MCP por **stdio**.

Objetivo: consultar e inspeccionar bases PostgreSQL con seguridad. La escritura y el mantenimiento vienen apagados por defecto.

## Seguridad rápida

- `POSTGRES_ENABLE_WRITE=false` por defecto.
- `POSTGRES_ENABLE_MAINTENANCE=false` por defecto.
- Las consultas de lectura corren en `BEGIN TRANSACTION READ ONLY`.
- La introspección usa parámetros (`$1`, `$2`), no concatena nombres enviados por el usuario.
- Los logs van a `stderr`. `stdout` queda reservado para MCP.
- Los errores no imprimen contraseñas ni URLs completas con credenciales.

## Instalación

```powershell
npm install
npm run build
```

## Configuración

Variables principales:

| Variable | Default | Uso |
|---|---:|---|
| `POSTGRES_URL` o `DATABASE_URL` | requerido | URL de conexión PostgreSQL. |
| `POSTGRES_ENABLE_WRITE` | `false` | Habilita `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY`. |
| `POSTGRES_ENABLE_MAINTENANCE` | `false` | Habilita `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `VACUUM`, `ANALYZE`, `REINDEX`, `GRANT`, `REVOKE`. |
| `PG_STATEMENT_TIMEOUT_MS` | `30000` | Tiempo máximo de sentencia. |
| `PG_MAX_CONNECTIONS` | `10` | Máximo de conexiones del pool. |
| `TRANSACTION_TIMEOUT_MS` | `60000` | Tiempo máximo de transacciones pendientes. |
| `MAX_CONCURRENT_TRANSACTIONS` | `5` | Máximo de transacciones de escritura abiertas. |

También podés pasar la URL como primer argumento del binario.

## OpenCode

Ejemplo seguro, sin secretos reales:

```json
"DB_ejemplo": {
  "type": "local",
  "command": [
    "node",
    "D:/work/postgres-mcp-server/dist/index.js"
  ],
  "environment": {
    "POSTGRES_URL": "postgresql://USER:PASSWORD@HOST:5432/DB_NAME",
    "POSTGRES_ENABLE_WRITE": "false",
    "POSTGRES_ENABLE_MAINTENANCE": "false",
    "PG_STATEMENT_TIMEOUT_MS": "30000"
  },
  "enabled": true,
  "timeout": 60000
}
```

Si usás paquete instalado:

```json
"command": ["npx", "-y", "postgres-mcp-server"]
```

## Tools MCP

### `execute_query`

Ejecuta SQL de lectura: `SELECT`, `WITH`, `EXPLAIN`, `SHOW`.

Entrada:

```json
{ "sql": "SELECT now()" }
```

### `execute_dml_ddl_dcl_tcl`

Ejecuta escritura solo si `POSTGRES_ENABLE_WRITE=true`. Deja la transacción abierta y devuelve `transaction_id`.

Entrada:

```json
{ "sql": "UPDATE users SET active = true WHERE id = 1" }
```

Después llamá a `execute_commit` o `execute_rollback`.

### `execute_commit`

Confirma una transacción pendiente.

```json
{ "transaction_id": "tx_..." }
```

### `execute_rollback`

Revierte una transacción pendiente.

```json
{ "transaction_id": "tx_..." }
```

### `execute_maintenance`

Ejecuta mantenimiento solo si `POSTGRES_ENABLE_MAINTENANCE=true`.

### `list_schemas`

Lista esquemas no internos visibles para el usuario conectado.

### `list_tables`

Lista tablas. Acepta filtro opcional:

```json
{ "schema_name": "public" }
```

### `describe_table`

Describe columnas, índices y constraints.

```json
{ "schema_name": "public", "table_name": "users" }
```

## Desarrollo

```powershell
npm ci
npm run build
npm test -- --run --coverage
npm run lint
```

Los tests usan fakes/mocks. No necesitan una base PostgreSQL real.

## CI

GitHub Actions ejecuta Node 20 y 22 con cache npm, build, lint y coverage. El mínimo es 85% en líneas, funciones, ramas y statements.

## Más documentación

- `docs/configuracion.md`
- `docs/seguridad-sql.md`
- `docs/desarrollo.md`
