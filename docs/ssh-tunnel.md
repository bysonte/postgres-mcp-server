# Lanzador con túnel SSH

Este lanzador opcional utiliza la preparación de conexión por base del MCP. Requiere Node.js y el cliente `ssh` de OpenSSH, autenticación por clave sin interacción (clave local o agente) y la clave del servidor previamente verificada en `known_hosts`. Nunca desactiva la verificación de identidad ni guarda contraseñas SSH. Después de actualizar el código, ejecutá `npm run build` y reconectá los clientes MCP que ya estuvieran abiertos.

## Preparación

1. Copiá `ssh-tunnel.example.json` a `ssh-tunnel.json` (ignorado por Git).
2. Configurá `host`, `user` y, opcionalmente, `sshPort`, `localPort`, `remotePort` e `identityFile`. Los puertos predeterminados son 22, 15432 y 5432. El destino remoto es siempre `127.0.0.1` de la VPS.
3. El arranque bajo demanda está asociado únicamente a los identificadores `HOMERO_SE7EN_VILLAGE` y `HOMERO_SE7EN_VILLAGE_DEV`. En el `.env`, cambiá **solo host y puerto** de esas dos bases a `127.0.0.1:15432`. Conservá credenciales, nombres de base, parámetros de conexión y permisos. Las demás conexiones no cambian; no configures otras bases para depender de este puerto sin ampliar explícitamente esa asociación.
4. Ejecutá `node scripts/start-with-ssh.mjs --check`. Comprueba el túnel y una respuesta del protocolo PostgreSQL sin autenticarse ni ejecutar SQL; después libera su uso sin interrumpir otros clientes activos.
5. En el cliente MCP, cambiá el comando a `node D:/work/postgres-mcp-server/scripts/start-with-ssh.mjs`. Conservá `POSTGRES_ENV_PATH` y las demás opciones.

Se puede indicar otra configuración con `POSTGRES_SSH_CONFIG_PATH`. El lanzador conserva el entorno del MCP y transmite su protocolo por stdin/stdout; los diagnósticos van únicamente a stderr. No usar `npm run start:ssh` como comando stdio del cliente, porque npm puede escribir mensajes adicionales en stdout.

## Funcionamiento y fallos

- Escucha solo en `127.0.0.1`; no publica la base en la red de tu PC.
- El MCP inicia y permite listar bases sin leer la configuración SSH ni abrir el túnel. Solo las operaciones sobre las dos bases de Seven esperan a que esté disponible; las operaciones de otros proyectos continúan independientemente, incluso si falta `ssh-tunnel.json`.
- La primera operación de Seven abre el túnel y espera su disponibilidad (hasta unos 25 segundos contando el coordinador). Las llamadas concurrentes comparten ese intento. Un fallo afecta únicamente a esas operaciones; la siguiente llamada de Seven vuelve a intentar abrirlo.
- No usa como alternativa la IP pública si SSH falla.
- Los clientes que usan la misma configuración comparten el túnel mediante un coordinador local. Al terminar el último cliente, el coordinador cierra SSH después de un segundo de gracia. Cerrar un cliente no interrumpe los demás.
- Si SSH se desconecta, el MCP y las demás bases siguen disponibles. La siguiente operación de Seven solicita de nuevo el túnel. No se reintentan consultas SQL automáticamente ni se promete continuar transacciones interrumpidas: hay que comprobar su resultado antes de repetir una escritura.
- Si el puerto local está ocupado por un proceso ajeno, falla de forma segura: no lo reutiliza ni lo mata. El coordinador verifica que los clientes compartan el mismo destino y configuración antes de habilitar operaciones de Seven.
- Cambiar el destino en un `.env` compartido afecta a todos los clientes que lo usan: también deben arrancar mediante este lanzador o contar con ese túnel disponible.
- Si un cliente es terminado por el sistema operativo, cerrar su conexión al coordinador libera su uso del túnel. Matar forzosamente el propio coordinador sí puede impedir la limpieza de SSH. Comprobá siempre la identidad del proceso antes de cerrarlo manualmente.

## Antes de cerrar el acceso público

Verificá ambos accesos mediante una consulta de solo lectura con el MCP. Solo después restringí el puerto público con una regla compatible con Docker Swarm que conserve el acceso local de la VPS. El lanzador no modifica el cortafuegos, PostgreSQL ni el servidor remoto.
