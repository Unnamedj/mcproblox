const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SCRIPTS_DIR = '/tmp/roblox-scripts';
const CONFIG_FILE = '/tmp/server-config.json';

let config = {
    scripts: {},
    executionHistory: [],
    pendingExecutions: {},
    lastUpdated: new Date().toISOString()
};

async function initialize() {
    try {
        await fs.ensureDir(SCRIPTS_DIR);
        if (await fs.pathExists(CONFIG_FILE)) {
            config = await fs.readJson(CONFIG_FILE);
        } else {
            await fs.writeJson(CONFIG_FILE, config);
        }
        console.log('✓ Servidor inicializado');
    } catch (error) {
        console.error('Error:', error);
    }
}

function validateLua(code) {
    const errors = [];
    const brackets = { '(': 0, '[': 0, '{': 0 };
    const closing = { ')': '(', ']': '[', '}': '{' };
    for (let i = 0; i < code.length; i++) {
        const char = code[i];
        if (brackets.hasOwnProperty(char)) brackets[char]++;
        else if (closing.hasOwnProperty(char)) brackets[closing[char]]--;
    }
    Object.entries(brackets).forEach(([bracket, count]) => {
        if (count > 0) errors.push(`${count} '${bracket}' sin cerrar`);
        if (count < 0) errors.push(`'${bracket}' cerrado sin abrir`);
    });
    return { isValid: errors.length === 0, errors };
}

// RUTAS BÁSICAS
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '3.0.0' });
});

app.get('/api/scripts', async (req, res) => {
    try {
        const scripts = {};
        const files = await fs.readdir(SCRIPTS_DIR);
        for (const file of files) {
            if (file.endsWith('.lua')) {
                const name = file.replace('.lua', '');
                scripts[name] = await fs.readFile(path.join(SCRIPTS_DIR, file), 'utf-8');
            }
        }
        res.json({ success: true, scripts });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/scripts', async (req, res) => {
    const { scripts: uploadedScripts } = req.body;
    try {
        let saved = 0;
        for (const [name, code] of Object.entries(uploadedScripts || {})) {
            const filePath = path.join(SCRIPTS_DIR, `${name}.lua`);
            await fs.writeFile(filePath, code, 'utf-8');
            config.scripts[name] = { savedAt: new Date().toISOString() };
            saved++;
        }
        config.lastUpdated = new Date().toISOString();
        await fs.writeJson(CONFIG_FILE, config);
        res.json({ success: true, saved });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/validate', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Sin código' });
    const validation = validateLua(code);
    res.json({ success: true, isValid: validation.isValid, errors: validation.errors });
});

app.get('/api/scripts/:name', async (req, res) => {
    try {
        const filePath = path.join(SCRIPTS_DIR, `${req.params.name}.lua`);
        if (!await fs.pathExists(filePath)) {
            return res.status(404).json({ success: false, error: 'No encontrado' });
        }
        const code = await fs.readFile(filePath, 'utf-8');
        res.json({ success: true, code });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/scripts/:name', async (req, res) => {
    try {
        const filePath = path.join(SCRIPTS_DIR, `${req.params.name}.lua`);
        if (await fs.pathExists(filePath)) {
            await fs.remove(filePath);
            delete config.scripts[req.params.name];
            await fs.writeJson(CONFIG_FILE, config);
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, error: 'No encontrado' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// INYECCIÓN REMOTA
app.post('/api/execute-remote', async (req, res) => {
    const { scriptName, code, parameters } = req.body;
    if (!scriptName || !code) {
        return res.status(400).json({ success: false, error: 'Falta código o nombre' });
    }
    try {
        const validation = validateLua(code);
        if (!validation.isValid) {
            return res.json({ success: false, error: `Errores: ${validation.errors.join(', ')}` });
        }
        const executionId = uuidv4();
        config.pendingExecutions[executionId] = {
            id: executionId,
            name: scriptName,
            code: code,
            parameters: parameters || {},
            createdAt: new Date().toISOString(),
            status: 'pending'
        };
        const filePath = path.join(SCRIPTS_DIR, `${scriptName}.lua`);
        await fs.writeFile(filePath, code, 'utf-8');
        config.scripts[scriptName] = { savedAt: new Date().toISOString() };
        await fs.writeJson(CONFIG_FILE, config);
        res.json({ success: true, executionId, message: 'Script pendiente' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pending-executions', (req, res) => {
    const pending = Object.values(config.pendingExecutions)
        .filter(exec => exec.status === 'pending')
        .slice(0, 5);
    res.json({ success: true, count: pending.length, executions: pending });
});

app.post('/api/execution/:id/result', (req, res) => {
    const { id } = req.params;
    const { success, output, error, executionTime } = req.body;
    try {
        if (config.pendingExecutions[id]) {
            config.pendingExecutions[id].status = success ? 'completed' : 'error';
            config.pendingExecutions[id].result = { success, output, error, executionTime };
            config.pendingExecutions[id].completedAt = new Date().toISOString();
            config.executionHistory.push({
                executionId: id,
                scriptName: config.pendingExecutions[id].name,
                timestamp: new Date().toISOString(),
                success, output
            });
            if (config.executionHistory.length > 100) {
                config.executionHistory = config.executionHistory.slice(-100);
            }
            fs.writeJson(CONFIG_FILE, config);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/execution/:id/status', (req, res) => {
    const execution = config.pendingExecutions[req.params.id];
    if (!execution) return res.status(404).json({ success: false, error: 'No encontrado' });
    res.json({ success: true, execution });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
    await initialize();
    app.listen(PORT, () => {
        console.log(`🚀 Servidor activo en puerto ${PORT}`);
    });
}

start().catch(console.error);
