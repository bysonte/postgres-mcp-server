# postgres-mcp-server

Servidor MCP **stdio** para varias bases PostgreSQL nombradas, con conexiones centralizadas en un archivo `.env`. OpenCode, Antigravity, Codex y Claude Code pueden usar el mismo archivo sin guardar URLs ni contraseñas en sus configuraciones. Lectura e introspección habilitadas; escritura y mantenimiento deshabilitados por defecto.

## Instalación

```powershell
npm install
npm run build
Copy-Item .env.example .env
```

Editá `.env` y asigná una URL real a cada base que vayas a utilizar. El ejemplo incluye todas las opciones disponibles para cada base. El archivo `.env` real está ignorado por Git; guardalo con permisos de archivo adecuados.

```dotenv
POSTGRES_DB_PRODUCTION_URL=postgresql://USER:PASSWORD@HOST:5432/DB_NAME
POSTGRES_DB_PRODUCTION_DESCRIPTION=Produccion
POSTGRES_DB_PRODUCTION_ENABLE_WRITE=false
POSTGRES_DB_PRODUCTION_ENABLE_MAINTENANCE=false
POSTGRES_DB_DEVELOPMENT_URL=postgresql://USER:PASSWORD@localhost:5432/dev
POSTGRES_DB_DEVELOPMENT_ENABLE_WRITE=true
```

El nombre de base es `PRODUCTION` o `DEVELOPMENT` en las herramientas MCP. Una instancia MCP ve todas las bases de **un** archivo; varias instancias pueden usar archivos distintos con `POSTGRES_ENV_PATH`. Sin esta variable se usa `.env` junto al proyecto, independientemente del directorio de trabajo. Si se indica una ruta y no existe, la instancia falla al arrancar. Para uso como paquete instalado fuera del proyecto, indicá la ruta explícitamente.

## OpenCode

```json
"postgres_trabajo": {
  "type": "local",
  "command": ["node", "D:/work/postgres-mcp-server/dist/index.js"],
  "environment": {
    "POSTGRES_ENV_PATH": "D:/config/bases-trabajo.env"
  },
  "enabled": true,
  "timeout": 60000
}
```

Para usar `.env` junto al proyecto, omití `environment`. Si usás el paquete instalado, usá `"command": ["npx", "-y", "postgres-mcp-server"]` y configurá `POSTGRES_ENV_PATH` con ruta absoluta. Otros arneses solo necesitan el comando stdio y esa variable de ruta.

## Herramientas

1. `list_databases`: devuelve nombres, descripciones y permisos sin URLs ni secretos; admite `limit` (1–50) y `offset` para paginar.
2. `execute_query`: lectura en transacción `READ ONLY`; recibe `{ "database": "PRODUCTION", "sql": "SELECT now()" }`.
3. `execute_dml_ddl_dcl_tcl`: escritura habilitada por base; devuelve `transaction_id` pendiente.
4. `execute_commit` / `execute_rollback`: reciben `{ "database": "DEVELOPMENT", "transaction_id": "tx_..." }`.
5. `execute_maintenance`: mantenimiento si está habilitado por base; recibe `database` y `sql`.
6. `list_schemas`, `list_tables`, `describe_table`: introspección; reciben `database` y, cuando corresponde, `schema_name`/`table_name`.

Cada invocación lee nuevamente el archivo; si cambian una URL, un permiso o un límite, se rotan las conexiones afectadas. Se dejan terminar las operaciones iniciadas, se revierten las transacciones que quedaron pendientes y se cierran los pools anteriores antes de habilitar nuevas operaciones. Un archivo inválido, inaccesible o eliminado revoca el acceso hasta corregirlo. Para editar sin interrupciones, reemplazá el archivo de forma atómica.

## Seguridad

- Escritura y mantenimiento se habilitan explícitamente por base; ambos permisos son `false` por defecto.
- La lectura corre en `BEGIN TRANSACTION READ ONLY` y la introspección parametriza sus consultas.
- Los logs van a `stderr`; `stdout` queda reservado para el protocolo MCP.
- Una transacción iniciada antes de una recarga no puede confirmarse después de ella: se revierte al retirar el pool.

## Desarrollo

```powershell
npm ci
npm run build
npm run lint
npm test
npm run coverage
```

Las pruebas usan pools simulados. Más detalles: `docs/configuracion.md`, `docs/seguridad-sql.md` y `docs/desarrollo.md`.
