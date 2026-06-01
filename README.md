# mcproblox — RBX Executor

Panel web para generar scripts Lua con IA y ejecutarlos en Roblox.

## Variables en Railway

### Roblox + app
| Variable | Descripción |
|----------|-------------|
| `PORT` | Lo asigna Railway |

### IA — varias keys (recomendado)

Puedes poner **varias API keys separadas por coma**. Si una se queda sin cuota, el servidor prueba la siguiente.

| Variable | Ejemplo |
|----------|---------|
| `GEMINI_API_KEYS` | `key1,key2,key3` |
| `GEMINI_API_KEY` | Una sola (también funciona) |
| `ANTHROPIC_API_KEYS` | `sk-ant-...,sk-ant-...` |
| `ANTHROPIC_API_KEY` | Una sola |

### IA gratis extra ([lista de proveedores](https://github.com/cheahjs/free-llm-api-resources))

| Variable | Dónde sacarla |
|----------|----------------|
| `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai) — modelos `:free` |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — tier gratis |

Opcional:

| Variable | Default |
|----------|---------|
| `OPENROUTER_MODELS` | `qwen/qwen3-coder:free,meta-llama/llama-3.2-3b-instruct:free` |
| `GROQ_MODELS` | `llama-3.1-8b-instant,llama-3.3-70b-versatile` |

En la app usa **Gratis → Auto**: rota Gemini keys, luego OpenRouter, luego Groq.

## Cliente Roblox

Archivo: `client/loadstring.lua` — escanea el juego y ejecuta scripts desde la web.

## Desarrollo

```bash
npm install && npm start
```
