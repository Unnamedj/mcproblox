const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let state = {
    pendingScript: null,
    connections: {},
    lastResult: null
};

// Limpiar conexiones inactivas
setInterval(() => {
    const now = Date.now();
    Object.keys(state.connections).forEach(id => {
        if (now - state.connections[id].lastSeen > 15000) {
            delete state.connections[id];
        }
    });
}, 10000);

// ── HTTPS helper ───────────────────────────────────────
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
                try { resolve(JSON.parse(raw)); }
                catch(e) { reject(new Error('JSON parse')); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
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
    state.lastResult = { executionId, success, output: output || '', error: error || '', timestamp: Date.now() };
    res.json({ success: true });
});

// ── WEB APP ────────────────────────────────────────────
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

// ── IA PROXY ────────────────────────────────────────────
app.post('/api/ai', async (req, res) => {
    const { message, model } = req.body;
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

        // CLAUDE
        if (model === 'claude-haiku' || model === 'claude-sonnet') {
            const apiKey = process.env.ANTHROPIC_API_KEY;
            if (!apiKey) return res.status(500).json({ success: false, error: 'Falta API key Anthropic' });

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

            if (result.content && result.content[0]) {
                res.json({ success: true, code: result.content[0].text.trim() });
            } else {
                res.json({ success: false, error: result.error?.message || 'Sin respuesta Claude' });
            }
        }
        // GEMINI
        else if (model === 'gemini-flash' || model === 'gemini-pro') {
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) return res.status(500).json({ success: false, error: 'Falta API key Gemini' });

            result = await httpsPost(
                'generativelanguage.googleapis.com',
                `/v1beta/models/${model === 'gemini-flash' ? 'gemini-2.0-flash' : 'gemini-pro'}:generateContent?key=${apiKey}`,
                { 'Content-Type': 'application/json' },
                {
                    system_instruction: { parts: { text: systemPrompt } },
                    contents: [{
                        parts: [{ text: message }]
                    }],
                    generationConfig: {
                        maxOutputTokens: 2000,
                        temperature: 0.7
                    }
                }
            );

            if (result.candidates && result.candidates[0]?.content?.parts[0]) {
                res.json({ success: true, code: result.candidates[0].content.parts[0].text.trim() });
            } else {
                res.json({ success: false, error: result.error?.message || 'Sin respuesta Gemini' });
            }
        }
        else {
            res.status(400).json({ success: false, error: 'Modelo desconocido' });
        }
    } catch(e) {
        console.error('Error IA:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '4.2.0' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Puerto: ${PORT}`);
    console.log(`🔑 Claude: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}`);
    console.log(`🔑 Gemini: ${process.env.GEMINI_API_KEY ? '✓' : '✗'}`);
});
