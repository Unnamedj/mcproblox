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



### Escaneo del juego (Workspace)

El `loadstring` envía cada ~12 s un mapa del Workspace (plots, carpetas, modelos).
La IA usa esas rutas reales cuando pides cosas como *"ESP de los plots"*.

En la web verás **🗺️ X plots detectados** cuando el escaneo esté activo.

## Cliente Roblox (loadstring)

Archivo: `client/loadstring.lua`

1. Abre tu exploit en Roblox  
2. Pega el script **una sola vez** y ejecútalo  
3. En la web, genera un script y pulsa **Ejecutar en Roblox**  
4. El cliente lo recibe en ~1 s y lo ejecuta automáticamente  

La variable `API` al inicio del archivo debe apuntar a tu URL de Railway.

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
