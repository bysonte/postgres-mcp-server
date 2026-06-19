# Configuración

Usá `POSTGRES_URL` o `DATABASE_URL` para conectar.

Ejemplo PowerShell:

```powershell
$env:POSTGRES_URL="postgresql://USER:PASSWORD@HOST:5432/DB_NAME"
$env:POSTGRES_ENABLE_WRITE="false"
$env:POSTGRES_ENABLE_MAINTENANCE="false"
npm start
```

No pongas contraseñas reales en documentación, tickets o logs. Guardalas solo en configuración local segura.

## Defaults seguros

```text
POSTGRES_ENABLE_WRITE=false
POSTGRES_ENABLE_MAINTENANCE=false
PG_STATEMENT_TIMEOUT_MS=30000
TRANSACTION_TIMEOUT_MS=60000
MAX_CONCURRENT_TRANSACTIONS=5
```
