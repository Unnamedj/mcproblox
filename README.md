# mcproblox — RBX Executor

Panel web para generar scripts Lua con IA y ejecutarlos en Roblox vía cliente conectado.

## Variables en Railway

| Variable | Descripción |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key de Claude (Anthropic) |
| `GEMINI_API_KEY` | API key de Google Gemini |
| `PORT` | Lo asigna Railway automáticamente |

Al menos una de las dos keys de IA debe estar configurada.

## Modelos disponibles

| Selector | Modelo API | Uso |
|----------|------------|-----|
| Claude · Haiku | `claude-3-5-haiku-20241022` | Más barato |
| Claude · Sonnet | `claude-sonnet-4-6` | Mejor calidad |
| Gemini · Flash | `gemini-2.0-flash` | Rápido / económico |
| Gemini · Pro | `gemini-1.5-pro` | Más capaz |

## Desarrollo local

```bash
npm install
npm start
```

Abre `http://localhost:3000`

## API

- `GET /api/config` — proveedores disponibles según keys
- `POST /api/ai` — `{ message, model }` → genera Lua
- `POST /api/execute` — envía script al cliente Roblox
- `GET /api/status` — clientes conectados
