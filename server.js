/**
* SERVIDOR CON SISTEMA DE INYECCIÓN REMOTA
* Permite ejecutar scripts dinámicamente en Roblox
*/

import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';  // ← NUEVA LÍNEA IMPORTANTE

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SCRIPTS_DIR = '/tmp/roblox-scripts';
const CONFIG_FILE = '/tmp/server-config.json';

let config = {
   scripts: {},
   executionHistory: [],
   pendingExecutions: {},  // ← NUEVA - Guarda scripts por ejecutar
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
       console.error('Error:', error);
   }
}

// ============================================================================
// VALIDACIÓN LUA
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
// RUTAS API - BÁSICAS
// ============================================================================

app.get('/api/health', (req, res) => {
   res.json({
       status: 'ok',
       timestamp: new Date().toISOString(),
       version: '3.0.0'
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
           
           if (!validation.isValid) continue;
           
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

// ============================================================================
// RUTAS API - INYECCIÓN REMOTA (NUEVAS)
// ============================================================================

/**
* ⭐ EJECUTAR SCRIPT REMOTAMENTE
* POST /api/execute-remote
*/
app.post('/api/execute-remote', async (req, res) => {
   const { scriptName, code, parameters } = req.body;
   
   if (!scriptName || !code) {
       return res.status(400).json({ success: false, error: 'Falta código o nombre' });
   }
   
   try {
       // Validar Lua
       const validation = validateLua(code);
       if (!validation.isValid) {
           return res.json({
               success: false,
               error: `Errores de sintaxis: ${validation.errors.join(', ')}`
           });
       }
       
       // ← CREAR ID ÚNICO PARA ESTA EJECUCIÓN
       const executionId = uuidv4();
       
       // ← GUARDAR COMO "PENDIENTE" (esperando a Roblox)
       config.pendingExecutions[executionId] = {
           id: executionId,
           name: scriptName,
           code: code,
           parameters: parameters || {},
           createdAt: new Date().toISOString(),
           status: 'pending'
       };
       
       // Guardar script
       const filePath = path.join(SCRIPTS_DIR, `${scriptName}.lua`);
       await fs.writeFile(filePath, code, 'utf-8');
       
       config.scripts[scriptName] = {
           savedAt: new Date().toISOString(),
           size: code.length
       };
       
       await fs.writeJson(CONFIG_FILE, config);
       
       res.json({
           success: true,
           executionId: executionId,
           message: 'Script en espera de inyección',
           waitingFor: 'Roblox Inyector'
       });
   } catch (error) {
       res.status(500).json({ success: false, error: error.message });
   }
});

/**
* ⭐ OBTENER SCRIPTS PENDIENTES
* GET /api/pending-executions
* (El Inyector de Roblox consulta esto cada 1 segundo)
*/
app.get('/api/pending-executions', (req, res) => {
   const pending = Object.values(config.pendingExecutions)
       .filter(exec => exec.status === 'pending')
       .slice(0, 5); // Máximo 5 a la vez
   
   res.json({
       success: true,
       count: pending.length,
       executions: pending
   });
});

/**
* ⭐ RECIBIR RESULTADO DE EJECUCIÓN
* POST /api/execution/:id/result
* (El Inyector de Roblox envía el resultado aquí)
*/
app.post('/api/execution/:id/result', (req, res) => {
   const { id } = req.params;
   const { success, output, error, executionTime } = req.body;
   
   try {
       if (config.pendingExecutions[id]) {
           config.pendingExecutions[id].status = success ? 'completed' : 'error';
           config.pendingExecutions[id].result = {
               success: success,
               output: output,
               error: error,
               executionTime: executionTime
           };
           config.pendingExecutions[id].completedAt = new Date().toISOString();
           
           // Guardar en historial
           config.executionHistory.push({
               executionId: id,
               scriptName: config.pendingExecutions[id].name,
               timestamp: new Date().toISOString(),
               success: success,
               output: output
           });
           
           if (config.executionHistory.length > 100) {
               config.executionHistory = config.executionHistory.slice(-100);
           }
           
           fs.writeJson(CONFIG_FILE, config);
       }
       
       res.json({ success: true, message: 'Resultado recibido' });
   } catch (error) {
       res.status(500).json({ success: false, error: error.message });
   }
});

/**
* ⭐ OBTENER ESTADO DE EJECUCIÓN
* GET /api/execution/:id/status
*/
app.get('/api/execution/:id/status', (req, res) => {
   const { id } = req.params;
   
   const execution = config.pendingExecutions[id];
   
   if (!execution) {
       return res.status(404).json({ success: false, error: 'No encontrado' });
   }
   
   res.json({
       success: true,
       execution: {
           id: execution.id,
           scriptName: execution.name,
           status: execution.status,
           result: execution.result || null,
           createdAt: execution.createdAt,
           completedAt: execution.completedAt
       }
   });
});

/**
* ⭐ LISTAR EJECUCIONES RECIENTES
* GET /api/execution-history
*/
app.get('/api/execution-history', (req, res) => {
   res.json({
       success: true,
       count: config.executionHistory.length,
       history: config.executionHistory.slice(-20)
   });
});

// ============================================================================
// RUTAS API - INFORMACIÓN
// ============================================================================

app.get('/api/info', (req, res) => {
   res.json({
       name: 'Roblox Inyector Remoto',
       version: '3.0.0',
       scriptsCount: Object.keys(config.scripts).length,
       executionCount: config.executionHistory.length,
       pendingCount: Object.values(config.pendingExecutions)
           .filter(e => e.status === 'pending').length,
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
       console.log('║  🚀 INYECTOR REMOTO - ACTIVO      ║');
       console.log('╚════════════════════════════════════╝\n');
       console.log(`🌐 Puerto: ${PORT}`);
       console.log(`✓ Sistema de inyección remota activo\n`);
   });
}

start().catch(console.error);
