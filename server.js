const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '4.4.0';

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
    if (scan.playerCount != null) lines.push(`Jugadores en servidor: ${scan.playerCount}`);
    if (Array.isArray(scan.workspaceChildren) && scan.workspaceChildren.length) {
        lines.push(`Workspace (nivel 1): ${scan.workspaceChildren.slice(0, 25).join(', ')}`);
    }
    if (Array.isArray(scan.plots) && scan.plots.length) {
        lines.push('Objetos plot/base detectados (usa estas rutas exactas):');
        for (const p of scan.plots.slice(0, 45)) {
            let line = `  - ${p.path} [${p.className || 'Instance'}]`;
            if (p.children?.length) line += ` → hijos: ${p.children.join(', ')}`;
            lines.push(line);
        }
    }
    if (Array.isArray(scan.notable) && scan.notable.length) {
        lines.push('Otros modelos relevantes:');
        for (const n of scan.notable.slice(0, 20)) {
            lines.push(`  - ${n.path} [${n.className}]`);
        }
    }
    return lines.join('\n');
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
    return {
        plotCount: Array.isArray(scan.plots) ? scan.plots.length : 0,
        workspaceItems: Array.isArray(scan.workspaceChildren) ? scan.workspaceChildren.length : 0,
        scannedAt: scan.scannedAt || null,
        gameName: scan.gameName || null
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
const GEMINI_PRO_MODELS = ['gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-lite'];

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
            claude: Boolean(process.env.ANTHROPIC_API_KEY),
            gemini: Boolean(process.env.GEMINI_API_KEY)
        },
        defaultModel: 'claude-haiku'
    });
});

// ── IA PROXY ────────────────────────────────────────────
app.post('/api/ai', async (req, res) => {
    const { message, model: requestedModel, clientId } = req.body;
    const model = requestedModel || 'claude-haiku';
    if (!message) return res.status(400).json({ success: false, error: 'Sin mensaje' });

    const worldScan = getWorldScan(clientId);
    const worldContext = formatWorldContext(worldScan);
    const maxTokens = worldContext ? 4096 : 2000;

    const systemPrompt = `Eres un experto en Lua y Roblox. Creas scripts Lua para ejecutar desde un exploit.
REGLAS:
- SOLO código Lua, sin explicaciones
- Sin markdown, sin backticks
- Funciona desde contexto cliente (LocalPlayer)
- UI mobile: ScreenGui, botones 50px+ alto
- Variables locales
- Código 100% funcional y COMPLETO (cierra todos los end/function; nunca cortes el código)
- Si hay CONTEXTO DEL JUEGO, usa las rutas Workspace exactas listadas (plots, carpetas, modelos)
- Para ESP de plots: itera los paths reales del contexto, no inventes nombres`;

    let userContent = message;
    if (worldContext) {
        userContent = `CONTEXTO DEL JUEGO (escaneo en vivo del Workspace):\n${worldContext}\n\n---\nPEDIDO:\n${message}`;
    }

    try {
        let result;

        if (model === 'claude-haiku' || model === 'claude-sonnet') {
            const apiKey = process.env.ANTHROPIC_API_KEY;
            if (!apiKey) {
                return res.status(500).json({ success: false, error: 'Falta ANTHROPIC_API_KEY en Railway' });
            }

            result = await httpsPost(
                'api.anthropic.com',
                '/v1/messages',
                {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                {
                    model: model === 'claude-haiku' ? 'claude-3-5-haiku-20241022' : 'claude-sonnet-4-6',
                    max_tokens: maxTokens,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userContent }]
                }
            );

            if (result.content?.[0]?.text) {
                return res.json({ success: true, code: stripCodeFences(result.content[0].text), model, usedScan: Boolean(worldContext) });
            }
            return res.json({ success: false, error: apiErrorMessage(result, 'Sin respuesta Claude') });
        }

        if (model === 'gemini-flash' || model === 'gemini-pro') {
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) {
                return res.status(500).json({ success: false, error: 'Falta GEMINI_API_KEY en Railway' });
            }

            const candidates = geminiModelCandidates(model);
            const geminiBody = {
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: 'user', parts: [{ text: userContent }] }],
                generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
            };

            let lastRaw = '';
            for (const geminiModel of candidates) {
                result = await httpsPost(
                    'generativelanguage.googleapis.com',
                    `/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
                    { 'Content-Type': 'application/json' },
                    geminiBody
                );

                const part = result.candidates?.[0]?.content?.parts?.find(p => p.text);
                if (part?.text) {
                    return res.json({
                        success: true,
                        code: stripCodeFences(part.text),
                        model,
                        geminiModel
                    });
                }

                lastRaw = apiErrorMessage(result, 'Sin respuesta Gemini');
                if (!isQuotaError(lastRaw)) break;
            }

            return res.json({
                success: false,
                error: userFriendlyError(lastRaw),
                errorType: isQuotaError(lastRaw) ? 'quota' : 'api'
            });
        }

        return res.status(400).json({ success: false, error: 'Modelo desconocido' });
    } catch (e) {
        console.error('Error IA:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    version: VERSION,
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY)
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 RBX Executor v${VERSION} — puerto ${PORT}`);
    console.log(`🔑 Claude: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}`);
    console.log(`🔑 Gemini: ${process.env.GEMINI_API_KEY ? '✓' : '✗'}`);
});
