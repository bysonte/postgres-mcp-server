# Desarrollo

Comandos principales:

```powershell
npm ci
npm run build
npm test -- --run --coverage
npm run lint
```

## Tests

La suite usa Vitest y fakes de PostgreSQL. No requiere una base real.

Áreas cubiertas:

- Validación SQL.
- Respuestas MCP y redacción de secretos.
- Configuración.
- Ejecución de lectura/escritura/mantenimiento.
- Introspección parametrizada.
- Limpieza de transacciones.
- Registro MCP con `registerTool`.

## Cobertura

El gate mínimo es 85% para líneas, funciones, ramas y statements.
