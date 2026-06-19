# Seguridad SQL

La regla principal es simple: lectura sí, cambios no salvo permiso explícito.

## Permitido por defecto

- `SELECT`
- `WITH`
- `EXPLAIN`
- `SHOW`

Estas consultas corren en modo `READ ONLY`.

## Bloqueado por defecto

- Escritura: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY`.
- Mantenimiento/DDL: `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `VACUUM`, `ANALYZE`, `REINDEX`, `GRANT`, `REVOKE`.
- Multi-sentencias con `;` intermedio.
- SQL ambiguo.

## Recomendación PostgreSQL

Creá un usuario dedicado con permisos mínimos. Para uso diario, preferí un usuario de solo lectura.
