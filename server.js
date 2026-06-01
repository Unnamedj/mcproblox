const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

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

// Limpiar conexiones inactivas cada 10s
setInterval(() => {
    const now = Date.now();
    Object.keys(state.connections).forEach(id => {
        if (now - state.connections[id].lastSeen > 15000) {
            delete state.connections[id];
        }
    });
}, 10000);

// ── ROBLOX ROUTES ──────────────────────────────────────

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

// ── WEB APP ROUTES ─────────────────────────────────────

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
        clients: connections,
        hasPending: !!state.pendingScript,
        lastResult: state.lastResult
    });
});

// ── CLAUDE PROXY ───────────────────────────────────────

app.post('/api/ai', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Sin mensaje' });

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 2000,
                system: `Eres un experto en Lua y Roblox. Creas scripts Lua para ejecutar desde un exploit executor.

REGLAS ESTRICTAS:
- Responde SOLO con código Lua puro
- CERO explicaciones, CERO markdown, CERO backticks
- El código debe funcionar desde el cliente (LocalScript context)
- Para UI mobile: ScreenGui con botones grandes táctiles (mínimo 50px alto)
- Siempre usa variables locales
- Código 100% completo y funcional`,
                messages: [{ role: 'user', content: message }]
            })
        });

        const data = await response.json();

        if (data.content && data.content[0]) {
            res.json({ success: true, code: data.content[0].text.trim() });
        } else {
            res.json({ success: false, error: 'Sin respuesta de IA' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── START ──────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '4.0.0' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
});
