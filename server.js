const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '4.6.0';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let state = {
    pendingScript: null,
    connections: {},
    lastResult: null
};

setInterval(() => {
    const now = Date.now();
    Object.keys(state.connections).forEach(id => {
        if (now - state.connections[id].lastSeen > 15000) {
            delete state.connections[id];
        }
    });
}, 10000);


function formatWorldContext(scan) {
    if (!scan || typeof scan !== 'object') return '';
    const lines = [];
    lines.push(`Juego: ${scan.gameName || '?'}`);
    lines.push(`PlaceId: ${scan.placeId || '?'}`);
    if (scan.playerCount != null) lines.push(`Jugadores (${scan.playerCount}): ${(scan.players || []).slice(0, 20).join(', ')}`);

    if (scan.services && typeof scan.services === 'object') {
        const svc = Object.entries(scan.services).map(([k, v]) => `${k}(${v})`).join(', ');
        lines.push(`Servicios escaneados: ${svc}`);
    }

    if (Array.isArray(scan.tree) && scan.tree.length) {
        lines.push('');
        lines.push('ÁRBOL COMPLETO DEL JUEGO (usa estas rutas exactas en el script):');
        lines.push(...scan.tree.slice(0, 160));
    } else {
        if (Array.isArray(scan.workspaceChildren) && scan.workspaceChildren.length) {
            lines.push(`Workspace: ${scan.workspaceChildren.slice(0, 30).join(', ')}`);
        }
        if (Array.isArray(scan.plots) && scan.plots.length) {
            lines.push('Plots/bases:');
            for (const p of scan.plots.slice(0, 40)) {
                let line = `  - ${p.path} [${p.className}]`;
                if (p.children?.length) line += ` → ${p.children.join(', ')}`;
                lines.push(line);
            }
        }
    }

    if (Array.isArray(scan.paths) && scan.paths.length) {
        lines.push('');
        lines.push('Índice de rutas (path → clase):');
        for (const p of scan.paths.slice(0, 80)) {
            lines.push(`  ${p.path} [${p.className}]${p.children != null ? ` (${p.children} hijos)` : ''}`);
        }
    }

    if (scan.stats?.truncated) {
        lines.push('');
        lines.push('(Escaneo recortado por límite; prioriza rutas listadas arriba)');
    }

    const text = lines.join('\n');
    return text.length > 5500 ? text.slice(0, 5500) + '\n…(mapa recortado para dejar espacio al código)' : text;
}

function getWorldScan(clientId) {
    if (clientId && state.connections[clientId]?.worldScan) {
        return state.connections[clientId].worldScan;
    }
    const sorted = Object.values(state.connections)
        .filter(c => c.worldScan)
        .sort((a, b) => (b.worldScanAt || 0) - (a.worldScanAt || 0));
    return sorted[0]?.worldScan || null;
}

function summarizeScan(scan) {
    if (!scan) return null;
    const plotLike = (Array.isArray(scan.paths) ? scan.paths : []).filter(p =>
        /plot|base|house|island|land|slot|farm|zone/i.test(p.path || '')
    ).length;
    return {
        plotCount: plotLike || (Array.isArray(scan.plots) ? scan.plots.length : 0),
        nodeCount: scan.stats?.nodes || (Array.isArray(scan.paths) ? scan.paths.length : 0),
        lineCount: scan.stats?.lines || (Array.isArray(scan.tree) ? scan.tree.length : 0),
        workspaceItems: Array.isArray(scan.workspaceChildren) ? scan.workspaceChildren.length : 0,
        scannedAt: scan.scannedAt || null,
        gameName: scan.gameName || null,
        truncated: Boolean(scan.stats?.truncated)
    };
}

function httpsPost(hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const options = {
            hostname,
            path,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(data)
            }
        };
        const req = https.request(options, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    parsed._httpStatus = res.statusCode;
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Respuesta inválida (${res.statusCode})`));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function stripCodeFences(text) {
    if (!text) return '';
    const s = text.trim();
    const fenced = s.match(/^```(?:lua)?\s*\n?([\s\S]*?)```$/i);
    if (fenced) return fenced[1].trim();
    return s.replace(/^```(?:lua)?\n?/i, '').replace(/\n?```$/i, '').trim();
}

const GEMINI_FLASH_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
const GEMINI_PRO_MODELS = ['gemini-1.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash-lite'];

function isLuaComplete(code) {
    if (!code || typeof code !== 'string') return false;
    const t = code.trim();
    if (t.length < 30) return false;
    const badEnd = [
        /local\s+function\s+\w+\s*$/,
        /function\s+\w*\s*\([^)]*\)\s*$/,
        /\bthen\s*$/,
        /\bdo\s*$/,
        /\brepeat\s*$/,
        /=\s*$/,
        /,\s*$/,
        /\.\s*$/
    ];
    if (badEnd.some(re => re.test(t))) return false;
    const fn = (t.match(/\bfunction\b/g) || []).length;
    const ends = (t.match(/\bend\b/g) || []).length;
    if (fn > 0 && ends < fn) return false;
    return true;
}

function finalizeAiCode(raw, finishReason) {
    const code = stripCodeFences(raw);
    if (!isLuaComplete(code)) {
        return {
            ok: false,
            code,
            error: finishReason === 'MAX_TOKENS'
                ? 'El modelo cortó el código (límite de tokens). Prueba Claude → Haiku o un script más corto.'
                : 'El código generado está incompleto. Pulsa Crear de nuevo o usa Claude → Haiku.'
        };
    }
    return { ok: true, code };
}

function geminiModelCandidates(model) {
    return model === 'gemini-pro' ? GEMINI_PRO_MODELS : GEMINI_FLASH_MODELS;
}

function isQuotaError(msg) {
    if (!msg) return false;
    const m = String(msg).toLowerCase();
    return m.includes('quota') || m.includes('rate limit') || m.includes('resource_exhausted') || m.includes('exceeded');
}

function userFriendlyError(raw) {
    if (!raw) return 'Error desconocido';
    if (isQuotaError(raw)) {
        return 'Cuota gratis de Gemini agotada. Espera 1 minuto, usa Claude → Haiku, o revisa límites en aistudio.google.com';
    }
    const line = String(raw).split('\n')[0];
    return line.length > 220 ? line.slice(0, 220) + '…' : line;
}

function apiErrorMessage(result, fallback) {
    if (result?.error?.message) return result.error.message;
    if (Array.isArray(result?.error) && result.error[0]?.message) return result.error[0].message;
    if (result?._httpStatus && result._httpStatus >= 400) {
        return `${fallback} (HTTP ${result._httpStatus})`;
    }
    return fallback;
}


const keyPoolIndex = { gemini: 0, anthropic: 0 };

function parseApiKeys(multiEnv, singleEnv) {
    const raw = process.env[multiEnv] || process.env[singleEnv] || '';
    return String(raw).split(/[,;\n|]+/).map(k => k.trim()).filter(Boolean);
}

function getGeminiKeys() {
    return parseApiKeys('GEMINI_API_KEYS', 'GEMINI_API_KEY');
}

function getAnthropicKeys() {
    return parseApiKeys('ANTHROPIC_API_KEYS', 'ANTHROPIC_API_KEY');
}

function hasFreeProviders() {
    return getGeminiKeys().length > 0
        || Boolean(process.env.OPENROUTER_API_KEY)
        || Boolean(process.env.GROQ_API_KEY);
}

async function callChatCompletions(opts) {
    const { host, path, apiKey, model, systemPrompt, userContent, maxTokens, headers = {} } = opts;
    const result = await httpsPost(host, path, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...headers
    }, {
        model,
        max_tokens: maxTokens,
        temperature: 0.7,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ]
    });
    const text = result.choices?.[0]?.message?.content;
    if (text) {
        return {
            ok: true,
            text,
            finish: result.choices?.[0]?.finish_reason || 'stop'
        };
    }
    return { ok: false, error: apiErrorMessage(result, 'Sin respuesta'), retryable: isQuotaError(apiErrorMessage(result, '')) };
}

async function callGeminiKey(apiKey, geminiModel, geminiBody) {
    const result = await httpsPost(
        'generativelanguage.googleapis.com',
        `/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
        { 'Content-Type': 'application/json' },
        geminiBody
    );
    const part = result.candidates?.[0]?.content?.parts?.find(p => p.text);
    if (part?.text) {
        return {
            ok: true,
            text: part.text,
            finish: result.candidates?.[0]?.finishReason || 'STOP'
        };
    }
    const err = apiErrorMessage(result, 'Sin respuesta Gemini');
    return { ok: false, error: err, retryable: isQuotaError(err) };
}

async function callGeminiRotating(keys, modelId, geminiBody) {
    if (!keys.length) return { ok: false, error: 'Sin keys de Gemini' };
    const models = geminiModelCandidates(modelId);
    let lastError = '';
    for (let k = 0; k < keys.length; k++) {
        const apiKey = keys[(keyPoolIndex.gemini + k) % keys.length];
        for (const geminiModel of models) {
            const r = await callGeminiKey(apiKey, geminiModel, geminiBody);
            if (r.ok) {
                keyPoolIndex.gemini = (keyPoolIndex.gemini + k + 1) % keys.length;
                return { ok: true, text: r.text, finish: r.finish, geminiModel, via: `gemini:${geminiModel}` };
            }
            lastError = r.error;
            if (!r.retryable) return { ok: false, error: lastError };
        }
    }
    keyPoolIndex.gemini = (keyPoolIndex.gemini + 1) % keys.length;
    return { ok: false, error: lastError, retryable: isQuotaError(lastError) };
}

async function tryFreeProviders(systemPrompt, userContent, maxTokens) {
    const attempts = [];

    const orKey = process.env.OPENROUTER_API_KEY;
    if (orKey) {
        const orModels = (process.env.OPENROUTER_MODELS || 'qwen/qwen3-coder:free,meta-llama/llama-3.2-3b-instruct:free,google/gemma-3-4b-it:free')
            .split(',').map(s => s.trim()).filter(Boolean);
        for (const model of orModels) {
            attempts.push({
                name: `openrouter:${model}`,
                run: () => callChatCompletions({
                    host: 'openrouter.ai',
                    path: '/api/v1/chat/completions',
                    apiKey: orKey,
                    model,
                    systemPrompt,
                    userContent,
                    maxTokens,
                    headers: {
                        'HTTP-Referer': process.env.APP_URL || 'https://mcproblox-production.up.railway.app',
                        'X-Title': 'RBX Executor'
                    }
                })
            });
        }
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
        const groqModels = (process.env.GROQ_MODELS || 'llama-3.1-8b-instant,llama-3.3-70b-versatile')
            .split(',').map(s => s.trim()).filter(Boolean);
        for (const model of groqModels) {
            attempts.push({
                name: `groq:${model}`,
                run: () => callChatCompletions({
                    host: 'api.groq.com',
                    path: '/openai/v1/chat/completions',
                    apiKey: groqKey,
                    model,
                    systemPrompt,
                    userContent,
                    maxTokens
                })
            });
        }
    }

    const geminiKeys = getGeminiKeys();
    if (geminiKeys.length) {
        const geminiBody = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userContent }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
        };
        attempts.push({
            name: 'gemini-pool',
            run: async () => {
                const r = await callGeminiRotating(geminiKeys, 'gemini-flash', geminiBody);
                if (r.ok) return { ok: true, text: r.text, finish: r.finish };
                return { ok: false, error: r.error, retryable: r.retryable };
            }
        });
    }

    let lastError = 'No hay proveedores gratis configurados';
    for (const a of attempts) {
        try {
            const r = await a.run();
            if (r.ok) {
                const fin = finalizeAiCode(r.text, r.finish);
                if (fin.ok) return { ok: true, code: fin.code, via: a.name };
                lastError = fin.error;
                continue;
            }
            lastError = r.error || lastError;
        } catch (e) {
            lastError = e.message;
        }
    }
    return { ok: false, error: userFriendlyError(lastError) };
}

function respondAiCode(res, fin, meta) {
    if (!fin.ok) {
        return res.json({
            success: false,
            error: fin.error,
            partialCode: fin.code,
            incomplete: true,
            ...meta
        });
    }
    return res.json({ success: true, code: fin.code, ...meta });
}

// ── ROBLOX ─────────────────────────────────────────────
app.post('/api/heartbeat', (req, res) => {
    const { clientId, game, player, worldScan } = req.body;
    const id = clientId || uuidv4();
    const prev = state.connections[id] || {};
    state.connections[id] = {
        id,
        game: game || prev.game || 'Unknown',
        player: player || prev.player || 'Unknown',
        lastSeen: Date.now(),
        connectedAt: prev.connectedAt || Date.now(),
        worldScan: worldScan || prev.worldScan || null,
        worldScanAt: worldScan ? Date.now() : (prev.worldScanAt || null)
    };
    let toExecute = null;
    if (state.pendingScript) {
        toExecute = state.pendingScript;
        state.pendingScript = null;
    }
    res.json({ success: true, clientId: id, execute: toExecute });
});

app.post('/api/result', (req, res) => {
    const { executionId, success, output, error } = req.body;
    state.lastResult = {
        executionId,
        success,
        output: output || '',
        error: error || '',
        timestamp: Date.now()
    };
    res.json({ success: true });
});

app.post('/api/execute', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Sin código' });
    const online = Object.values(state.connections).filter(c => Date.now() - c.lastSeen < 20000);
    if (online.length === 0) {
        return res.status(503).json({
            success: false,
            error: 'No hay cliente Roblox conectado. Ejecuta el loadstring en tu exploit.'
        });
    }
    if (!isLuaComplete(code)) {
        return res.status(400).json({
            success: false,
            error: 'El código está incompleto (cortado). Genera de nuevo antes de ejecutar.'
        });
    }
    const executionId = uuidv4();
    state.pendingScript = { id: executionId, code };
    state.lastResult = null;
    res.json({ success: true, executionId });
});

app.get('/api/result/:id', (req, res) => {
    if (state.lastResult && state.lastResult.executionId === req.params.id) {
        res.json({ success: true, result: state.lastResult });
    } else {
        res.json({ success: false, pending: true });
    }
});

app.get('/api/status', (req, res) => {
    const connections = Object.values(state.connections);
    res.json({
        success: true,
        connections: connections.length,
        clients: connections.map(c => ({
            id: c.id,
            player: c.player,
            game: c.game,
            hasScan: Boolean(c.worldScan),
            worldScanAt: c.worldScanAt || null,
            scan: summarizeScan(c.worldScan)
        }))
    });
});

app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        version: VERSION,
        providers: {
            claude: getAnthropicKeys().length > 0,
            gemini: getGeminiKeys().length > 0,
            free: hasFreeProviders()
        },
        keyPools: {
            gemini: getGeminiKeys().length,
            anthropic: getAnthropicKeys().length,
            openrouter: process.env.OPENROUTER_API_KEY ? 1 : 0,
            groq: process.env.GROQ_API_KEY ? 1 : 0
        },
        defaultModel: 'free-auto'
    });
});

// ── IA PROXY ────────────────────────────────────────────
app.post('/api/ai', async (req, res) => {
    const { message, model: requestedModel, clientId } = req.body;
    const model = requestedModel || 'claude-haiku';
    if (!message) return res.status(400).json({ success: false, error: 'Sin mensaje' });

    const worldScan = getWorldScan(clientId);
    const worldContext = formatWorldContext(worldScan);
    const maxTokens = worldContext ? 8192 : 2000;

    const systemPrompt = `Eres un experto en Lua y Roblox. Creas scripts Lua para ejecutar desde un exploit.
REGLAS:
- SOLO código Lua, sin explicaciones
- Sin markdown, sin backticks
- Funciona desde contexto cliente (LocalPlayer)
- UI mobile: ScreenGui, botones 50px+ alto
- Variables locales
- Código COMPLETO y ejecutable: cierra TODOS los end/function. Scripts cortos y compactos si el pedido es simple
- Si hay CONTEXTO DEL JUEGO, usa SOLO rutas que aparecen en el árbol (Workspace, ReplicatedStorage, PlayerGui, etc.)
- Para ESP de plots: itera los paths reales del contexto, no inventes nombres`;

    let userContent = message;
    if (worldContext) {
        userContent = `CONTEXTO DEL JUEGO (escaneo en vivo del Workspace):\n${worldContext}\n\n---\nPEDIDO:\n${message}`;
    }

    try {
        let result;

        if (model === 'claude-haiku' || model === 'claude-sonnet') {
            const keys = getAnthropicKeys();
            if (!keys.length) {
                return res.status(500).json({ success: false, error: 'Falta ANTHROPIC_API_KEY en Railway' });
            }
            const anthropicModel = model === 'claude-haiku' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
            let lastErr = '';
            for (let k = 0; k < keys.length; k++) {
                const apiKey = keys[(keyPoolIndex.anthropic + k) % keys.length];
                result = await httpsPost(
                    'api.anthropic.com',
                    '/v1/messages',
                    {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    {
                        model: anthropicModel,
                        max_tokens: maxTokens,
                        system: systemPrompt,
                        messages: [{ role: 'user', content: userContent }]
                    }
                );
                if (result.content?.[0]?.text) {
                    keyPoolIndex.anthropic = (keyPoolIndex.anthropic + k + 1) % keys.length;
                    const fin = finalizeAiCode(result.content[0].text, result.stop_reason);
                    return respondAiCode(res, fin, { model, usedScan: Boolean(worldContext), via: 'claude' });
                }
                lastErr = apiErrorMessage(result, 'Sin respuesta Claude');
                if (!isQuotaError(lastErr)) break;
            }
            keyPoolIndex.anthropic = (keyPoolIndex.anthropic + 1) % keys.length;
            const fb = await tryFreeProviders(systemPrompt, userContent, maxTokens);
            if (fb.ok) return res.json({ success: true, code: fb.code, model, via: fb.via, usedScan: Boolean(worldContext) });
            return res.json({ success: false, error: lastErr || fb.error, errorType: 'quota' });
        }

        if (model === 'gemini-flash' || model === 'gemini-pro') {
            const keys = getGeminiKeys();
            if (!keys.length) {
                return res.status(500).json({ success: false, error: 'Falta GEMINI_API_KEY en Railway' });
            }
            const geminiBody = {
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: 'user', parts: [{ text: userContent }] }],
                generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
            };
            const gr = await callGeminiRotating(keys, model, geminiBody);
            if (gr.ok) {
                const fin = finalizeAiCode(gr.text, gr.finish);
                return respondAiCode(res, fin, { model, geminiModel: gr.geminiModel, via: gr.via, usedScan: Boolean(worldContext) });
            }
            const fb = await tryFreeProviders(systemPrompt, userContent, maxTokens);
            if (fb.ok) {
                return res.json({ success: true, code: fb.code, model, via: fb.via, usedScan: Boolean(worldContext) });
            }
            return res.json({
                success: false,
                error: userFriendlyError(gr.error || fb.error),
                errorType: 'quota'
            });
        }

        if (model === 'free-auto') {
            const fb = await tryFreeProviders(systemPrompt, userContent, maxTokens);
            if (fb.ok) {
                return res.json({ success: true, code: fb.code, model, via: fb.via, usedScan: Boolean(worldContext) });
            }
            return res.json({ success: false, error: fb.error, errorType: 'quota' });
        }

        return res.status(400).json({ success: false, error: 'Modelo desconocido' });
    } catch (e) {
        console.error('Error IA:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: VERSION }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 RBX Executor v${VERSION} — puerto ${PORT}`);
    console.log(`🔑 Claude: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}`);
    console.log(`🔑 Gemini: ${process.env.GEMINI_API_KEY ? '✓' : '✗'}`);
});
