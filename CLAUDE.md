# PendienteAI

> PWA para iPhone que monitorea WhatsApp y detecta tareas, eventos y compromisos.
> Este archivo es la referencia permanente del proyecto. Mantenerlo actualizado.

## Idioma de trabajo
Responder SIEMPRE en español rioplatense.

## Qué es
PWA para iPhone que monitorea WhatsApp. Tiene 3 funciones **separadas**:

1. **Análisis automático de chats**: detecta tareas/eventos/compromisos en conversaciones con otros.
2. **Sin responder**: detecta chats donde dejé mensajes sin contestar +1h. Es SOLO un recordatorio, separado de las tareas.
3. **Bot personal**: mando texto/audios y la IA los interpreta y anota como tarea. Funciona vía endpoint HTTP `POST /bot/command` (lo uso desde un Shortcut de iPhone), porque WAHA-WEBJS no captura los mensajes salientes del self-chat de WhatsApp.

## Infraestructura
- **Servidor**: Hetzner CX22 ARM64, Ubuntu 24.04, IP `5.75.174.110`, acceso: `ssh root@5.75.174.110`
- **Backend**: Node.js 20 + Express + PM2, en `/root/pendiente-ai`, puerto `3001`, app PM2 `pendiente-ai`
- **DB**: SQLite (better-sqlite3) en `/root/pendiente-ai/tasks.db`
- **WAHA** (WhatsApp HTTP API): Docker, engine WEBJS, puerto `3000`, sesión `default`. Número conectado: `17542365652@c.us` (Brandon Quevedo).
- **IA**: Groq. Texto = `llama-3.3-70b-versatile`. Audio = `whisper-large-v3-turbo` (español).
- **HTTPS**: Caddy. Backend público: `https://pendiente.transtidefreight.com`
- **Frontend**: HTML/CSS/JS vanilla, deploy en Vercel (proyecto `pendienteia`), URL `https://pendienteia.vercel.app`
- **Repo GitHub PRIVADO**: `github.com/brandon4320/PendienteAI` (branch `main`). Solo 2 archivos: `server.js` y `index.html`.

## Variables de entorno
Están en `/root/pendiente-ai/.env` del servidor:

```
GROQ_API_KEY
PORT=3001
WAHA_URL=http://localhost:3000
WAHA_API_KEY=pendiente2024
WAHA_SESSION=default
API_TOKEN=pendiente2024secret
MY_WA_NUMBER=17542365652@c.us
```

## Deploy estándar
```bash
cd /root/pendiente-ai && git pull && pm2 restart pendiente-ai
```

## REGLA DE ORO: validar sintaxis antes de reiniciar
Siempre correr `node -c server.js` antes de `pm2 restart`.

Si `git pull` deja el archivo corrupto (contenido `404: Not Found`):
```bash
git fetch origin && git reset --hard origin/main && node -c server.js && pm2 restart pendiente-ai
```

## CUIDADO con emojis (rompieron el parser de Node varias veces)
Nunca poner emojis literales dentro de strings con comillas simples. Definirlos con `String.fromCodePoint`:
- robot = `0x1F916`
- check = `0x2705`
- cross = `0x274C`

## Tablas SQLite
- **tasks**: `id, contact, preview, key_message, task, priority(ahora|hoy|semana), urgent, category(trabajo|personal), type(pendiente|mio|sin_responder), from_me, meeting_date, meeting_time, meeting_location, actions(JSON), phone, status(pending|resolved), created_at, resolved_at`
- **conv_history**: `id, contact, text, from_me, created_at` (retención 24h)
- **sin_responder_pending**: `contact(PK), last_msg, key_message, category, scheduled_at`
- **feedback**: `id, task_id, contact, task, preview, reason('error'|'done'), created_at`

## Endpoints
Auth con header `X-Api-Token: <API_TOKEN del .env>`, salvo `/webhook`, `/health`, `/stream`.

- `GET /tasks?type=pendiente|sin_responder|mio`
- `DELETE /tasks/:id`
- `PATCH /tasks/:id/snooze`
- `PATCH /tasks/:id/keep`
- `PATCH /tasks/:id/edit`
- `POST /tasks/:id/feedback` (descarte con motivo)
- `GET /feedback/stats`
- `GET /stream` (SSE tiempo real)
- `DELETE /reset`
- `GET /health`
- `POST /webhook` (valida `x-api-key` de WAHA)
- `POST /bot/command` (body `{"text":"..."}`, lo usa el Shortcut de iPhone)

## Flujo de análisis automático
WAHA webhook → guarda en `conv_history` → buffer de 20s de silencio → cola (1 cada 2s, máx 30/min por límite de Groq) → Groq analiza → crea tarea si `needsAction && confidence>=0.75` → SSE broadcast al frontend.

**Anti-alucinación de 3 capas**: prompt estricto + umbral de confianza + validación de que las palabras de la tarea existan en los mensajes reales.

## Frontend
3 bandejas (Pendientes / Sin resp. / Mis comp.), filtros trabajo/personal, cards por contacto, chips de acciones contextuales (Llamar, WhatsApp, Mail, Copiar CBU/Alias, Maps, Agendar en Google Calendar), modal de feedback al descartar (IA se equivocó / Ya lo resolví), botón reset, SSE en tiempo real, login por token. Pantalla de login que pide token (`pendiente2024secret`).

## Pendientes / TODO
- **SEGURIDAD URGENTE**: rotar las credenciales que quedaron expuestas en chats viejos (GitHub PAT, GROQ_API_KEY, password del servidor, API tokens). Mover todo a variables de entorno y regenerar las claves.
- Revisar que el bot vía `/bot/command` siga andando y mejorar el prompt si hace falta.

## Cómo trabajar en este proyecto
- Español rioplatense.
- Antes de editar `server.js`: leerlo, hacer el cambio, validar con `node -c`, después deploy.
- Cambios chicos y verificables, confirmando con logs (`pm2 logs pendiente-ai --lines N --nostream`).
- Hacer commits descriptivos.
