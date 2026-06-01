const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '4.3.0';

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

function geminiModelId(model) {
    if (model === 'gemini-pro') return 'gemini-1.5-pro';
    return 'gemini-2.0-flash';
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
    const { clientId, game, player } = req.body;
    const id = clientId || uuidv4();
    state.connections[id] = {
        id,
        game: game || 'Unknown',
        player: player || 'Unknown',
        lastSeen: Date.now(),
        connectedAt: state.connections[id]?.connectedAt || Date.now()
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
    res.json({ success: true, connections: connections.length, clients: connections });
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
    const { message, model: requestedModel } = req.body;
    const model = requestedModel || 'claude-haiku';
    if (!message) return res.status(400).json({ success: false, error: 'Sin mensaje' });

    const systemPrompt = `Eres un experto en Lua y Roblox. Creas scripts Lua para ejecutar desde un exploit.
REGLAS:
- SOLO código Lua, sin explicaciones
- Sin markdown, sin backticks
- Funciona desde contexto cliente
- UI mobile: ScreenGui, botones 50px+ alto
- Variables locales
- Código 100% funcional`;

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
                    max_tokens: 2000,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: message }]
                }
            );

            if (result.content?.[0]?.text) {
                return res.json({ success: true, code: stripCodeFences(result.content[0].text), model });
            }
            return res.json({ success: false, error: apiErrorMessage(result, 'Sin respuesta Claude') });
        }

        if (model === 'gemini-flash' || model === 'gemini-pro') {
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) {
                return res.status(500).json({ success: false, error: 'Falta GEMINI_API_KEY en Railway' });
            }

            const geminiModel = geminiModelId(model);
            result = await httpsPost(
                'generativelanguage.googleapis.com',
                `/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
                { 'Content-Type': 'application/json' },
                {
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents: [{ role: 'user', parts: [{ text: message }] }],
                    generationConfig: { maxOutputTokens: 2000, temperature: 0.7 }
                }
            );

            const part = result.candidates?.[0]?.content?.parts?.find(p => p.text);
            if (part?.text) {
                return res.json({ success: true, code: stripCodeFences(part.text), model });
            }

            const finish = result.candidates?.[0]?.finishReason;
            const suffix = finish && finish !== 'STOP' ? ` (${finish})` : '';
            return res.json({
                success: false,
                error: apiErrorMessage(result, 'Sin respuesta Gemini') + suffix
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
