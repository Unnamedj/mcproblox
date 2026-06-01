const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Estado en memoria
let state = {
    pendingScript: null,      // Script esperando ser ejecutado
    connections: {},          // Clientes Roblox conectados
    lastResult: null          // Último resultado de ejecución
};

// Limpiar conexiones inactivas cada 10 segundos
setInterval(() => {
    const now = Date.now();
    Object.keys(state.connections).forEach(id => {
        if (now - state.connections[id].lastSeen > 15000) {
            delete state.connections[id];
        }
    });
}, 10000);

// ============================================================
// RUTAS PARA ROBLOX (llamadas desde el loadstring)
// ============================================================

// Roblox hace heartbeat aquí para registrarse como conectado
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

    // Hay script pendiente? Devuélvelo y límpialo
    let toExecute = null;
    if (state.pendingScript) {
        toExecute = state.pendingScript;
        state.pendingScript = null;
    }

    res.json({
        success: true,
        clientId: id,
        execute: toExecute  // null o { id, code }
    });
});

// Roblox envía resultado de ejecución
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

// ============================================================
// RUTAS PARA LA WEB APP
// ============================================================

// Web app envía script para ejecutar
app.post('/api/execute', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Sin código' });

    const executionId = uuidv4();
    state.pendingScript = { id: executionId, code };
    state.lastResult = null;

    res.json({ success: true, executionId });
});

// Web app consulta resultado
app.get('/api/result/:id', (req, res) => {
    if (state.lastResult && state.lastResult.executionId === req.params.id) {
        res.json({ success: true, result: state.lastResult });
    } else {
        res.json({ success: false, pending: true });
    }
});

// Web app obtiene estado general
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '4.0.0' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
});
