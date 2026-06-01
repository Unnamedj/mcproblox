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
| Gemini · Flash | `gemini-2.5-flash` (+ fallback) | Gratis con límites |
| Gemini · Pro | `gemini-1.5-pro` (+ fallback) | Más capaz |

### Si sale "quota exceeded" en Gemini

La API gratis de Google tiene límite diario/por minuto. Opciones:

1. Esperar ~1 minuto y volver a intentar  
2. Cambiar a **Claude → Haiku** en la app  
3. Revisar uso en [Google AI Studio](https://aistudio.google.com/)

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
