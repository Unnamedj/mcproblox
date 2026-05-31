/**
 * ROBLOX MCP MOBILE - SERVER OPTIMIZADO PARA RAILWAY
 * Versión simplificada y lista para producción
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rutas de almacenamiento
const SCRIPTS_DIR = '/tmp/roblox-scripts';
const CONFIG_FILE = '/tmp/server-config.json';

let config = {
    scripts: {},
    executionHistory: [],
    lastUpdated: new Date().toISOString()
};

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

async function initialize() {
    try {
        await fs.ensureDir(SCRIPTS_DIR);
        
        if (await fs.pathExists(CONFIG_FILE)) {
            config = await fs.readJson(CONFIG_FILE);
        } else {
            await fs.writeJson(CONFIG_FILE, config);
        }
        
        console.log('✓ Servidor inicializado');
        console.log(`📁 Directorio: ${SCRIPTS_DIR}`);
    } catch (error) {
        console.error('Error inicializando:', error);
    }
}

// ============================================================================
// VALIDACIÓN BÁSICA LUA
// ============================================================================

function validateLua(code) {
    const errors = [];
    
    const brackets = { '(': 0, '[': 0, '{': 0 };
    const closing = { ')': '(', ']': '[', '}': '{' };
    
    for (let i = 0; i < code.length; i++) {
        const char = code[i];
        if (brackets.hasOwnProperty(char)) {
            brackets[char]++;
        } else if (closing.hasOwnProperty(char)) {
            brackets[closing[char]]--;
        }
    }
    
    Object.entries(brackets).forEach(([bracket, count]) => {
        if (count > 0) errors.push(`${count} '${bracket}' sin cerrar`);
        if (count < 0) errors.push(`'${bracket}' cerrado sin abrir`);
    });
    
    return { isValid: errors.length === 0, errors };
}

// ============================================================================
// RUTAS API
// ============================================================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
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
            const validation = validateLua(code);
            
            if (!validation.isValid) {
                continue;
            }
            
            const filePath = path.join(SCRIPTS_DIR, `${name}.lua`);
            await fs.writeFile(filePath, code, 'utf-8');
            
            config.scripts[name] = {
                savedAt: new Date().toISOString(),
                size: new Blob([code]).size
            };
            
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
    
    if (!code) {
        return res.status(400).json({ success: false, error: 'Sin código' });
    }
    
    const validation = validateLua(code);
    
    res.json({
        success: true,
        isValid: validation.isValid,
        errors: validation.errors,
        lines: code.split('\n').length
    });
});

app.post('/api/execute', async (req, res) => {
    const { name, code } = req.body;
    
    try {
        const validation = validateLua(code);
        if (!validation.isValid) {
            return res.json({
                success: false,
                error: `Errores: ${validation.errors.join(', ')}`
            });
        }
        
        const filePath = path.join(SCRIPTS_DIR, `${name}.lua`);
        await fs.writeFile(filePath, code, 'utf-8');
        
        config.executionHistory.push({
            scriptName: name,
            timestamp: new Date().toISOString(),
            size: code.length
        });
        
        if (config.executionHistory.length > 100) {
            config.executionHistory = config.executionHistory.slice(-100);
        }
        
        await fs.writeJson(CONFIG_FILE, config);
        
        res.json({
            success: true,
            message: 'Script ejecutado',
            script: name
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
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
            
            res.json({ success: true, message: 'Eliminado' });
        } else {
            res.status(404).json({ success: false, error: 'No encontrado' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/info', (req, res) => {
    res.json({
        name: 'Roblox MCP Mobile',
        version: '2.0.0',
        scriptsCount: Object.keys(config.scripts).length,
        executionCount: config.executionHistory.length,
        lastUpdated: config.lastUpdated
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// INICIAR
// ============================================================================

async function start() {
    await initialize();
    
    app.listen(PORT, () => {
        console.log('\n╔════════════════════════════════════╗');
        console.log('║  🚀 ROBLOX MCP RAILWAY - ACTIVO   ║');
        console.log('╚════════════════════════════════════╝\n');
        console.log(`🌐 Puerto: ${PORT}`);
        console.log(`✓ Listo para recibir conexiones\n`);
    });
}

start().catch(console.error);
