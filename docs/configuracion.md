# Configuración

El archivo `.env.example` contiene un bloque completo por base. Copialo como `.env`, editá las URLs y eliminá los bloques que no quieras exponer. El MCP toma su configuración de la ruta `POSTGRES_ENV_PATH` del arnés o, si no está definida, del `.env` junto al proyecto. La ruta explícita no tiene fallback.

Las variables siguen `POSTGRES_DB_<ID>_<PROPIEDAD>`: `<ID>` empieza con letra mayúscula y solo admite `A-Z`, `0-9` y `_`. Cada base requiere `URL`. `DESCRIPTION` aparece en `list_databases`; no pongas secretos allí. Las URLs pueden incluir parámetros estándar de conexión PostgreSQL; codificá caracteres especiales en usuario y contraseña.

Los permisos `ENABLE_WRITE` y `ENABLE_MAINTENANCE` empiezan en `false` por base. Se pueden definir límites globales en el mismo archivo (`PG_MAX_CONNECTIONS`, `PG_IDLE_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS`, `TRANSACTION_TIMEOUT_MS`, `MONITOR_INTERVAL_MS`, `ENABLE_TRANSACTION_MONITOR`, `MAX_CONCURRENT_TRANSACTIONS`); cada `POSTGRES_DB_<ID>_<PROPIEDAD>` correspondiente tiene prioridad. Los enteros requieren valores positivos y los booleanos `true` o `false`.

La lista de bases y la política se recargan automáticamente al invocar cualquier herramienta. La configuración se valida antes de ofrecer conexiones nuevas. Al cambiar/remover una base o revocar permisos, se espera el trabajo en curso, se revierten transacciones pendientes y se cierra el pool anterior. Cuando el archivo falla o no es válido, ninguna herramienta tiene acceso hasta que se corrija.

## Compatibilidad con instancia anterior

Si no hay ninguna variable `POSTGRES_DB_...`, se mantiene una única base llamada `default`: acepta `POSTGRES_URL` o `DATABASE_URL` del archivo o del entorno, o la URL como primer argumento. Los flags `POSTGRES_ENABLE_WRITE` y `POSTGRES_ENABLE_MAINTENANCE` solo se aplican a esta modalidad. Si nunca existió el `.env` predeterminado, puede seguir usándose solo el entorno o el argumento. Una vez cargado un archivo, su eliminación bloquea operaciones; una instancia que empezó con bases nombradas no vuelve automáticamente a `default`.

Con bases nombradas, las credenciales y permisos provienen **del archivo**, no de variables ambientales heredadas de otros arneses. `POSTGRES_ENV_PATH` elige el archivo, no su contenido.
