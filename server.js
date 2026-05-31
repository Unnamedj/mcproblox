const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

let proxies = [];
let proxyIndex = 0;

function loadProxies() {
  try {
    const raw = fs.readFileSync('proxies.txt', 'utf8');
    proxies = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
    console.log('Loaded ' + proxies.length + ' proxies from proxies.txt');
  } catch (e) {
    if (process.env.PROXIES) {
      proxies = process.env.PROXIES.split(',').map(p => p.trim()).filter(Boolean);
      console.log('Loaded ' + proxies.length + ' proxies from env');
    } else {
      console.log('No proxies loaded - running direct');
    }
  }
}

function parseProxy(str) {
  if (!str) return null;
  const s = str.trim();
  if (s.includes('@')) {
    const at = s.lastIndexOf('@');
    const left = s.slice(0, at);
    const right = s.slice(at + 1);
    const parts = right.split(':');
    if (parts.length < 2) return null;
    const host = parts[0];
    const port = parseInt(parts[1]);
    const colon = left.indexOf(':');
    if (colon === -1) return { host, port, username: null, password: null };
    return { host, port, username: left.slice(0, colon), password: left.slice(colon + 1) };
  }
  const parts = s.split(':');
  if (parts.length === 4) {
    const secondIsPort = !isNaN(parseInt(parts[1])) && parts[1].length <= 5;
    if (secondIsPort) return { host: parts[0], port: parseInt(parts[1]), username: parts[2], password: parts[3] };
    return { host: parts[2], port: parseInt(parts[3]), username: parts[0], password: parts[1] };
  }
  if (parts.length === 2) return { host: parts[0], port: parseInt(parts[1]), username: null, password: null };
  return null;
}

function getProxyAgent() {
  if (proxies.length === 0) return undefined;
  const raw = proxies[proxyIndex % proxies.length];
  proxyIndex++;
  const p = parseProxy(raw);
  if (!p) return undefined;
  const auth = p.username && p.password ? p.username + ':' + p.password + '@' : '';
  return new HttpsProxyAgent('http://' + auth + p.host + ':' + p.port);
}

const rateLimits = {};
function isRL(platform) {
  if (!rateLimits[platform]) return false;
  if (Date.now() > rateLimits[platform]) { delete rateLimits[platform]; return false; }
  return true;
}
function setRL(platform, ms) {
  rateLimits[platform] = Date.now() + ms;
  console.log('Rate limited [' + platform + '] cooldown ' + (ms / 1000) + 's');
}

const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

async function checkRoblox(name) {
  if (isRL('roblox')) return { rateLimited: true };
  try {
    const r = await axios.get(
      'https://auth.roblox.com/v1/usernames/validate?Username=' + encodeURIComponent(name) + '&Birthday=2000-01-01',
      { httpsAgent: getProxyAgent(), proxy: false, timeout: TIMEOUT, headers: { 'User-Agent': UA } }
    );
    return { available: r.data.code === 0 };
  } catch (e) {
    if (e.response && e.response.status === 429) { setRL('roblox', 90000); return { rateLimited: true }; }
    return { available: false, error: e.code || e.message };
  }
}

async function checkDiscord(name) {
  if (isRL('discord')) return { rateLimited: true };
  try {
    const r = await axios.post(
      'https://discord.com/api/v9/auth/verify-username',
      { username: name },
      { httpsAgent: getProxyAgent(), proxy: false, timeout: TIMEOUT, headers: { 'Content-Type': 'application/json', 'User-Agent': UA } }
    );
    return { available: r.data.taken === false };
  } catch (e) {
    if (e.response && e.response.status === 429) { setRL('discord', 120000); return { rateLimited: true }; }
    return { available: false, error: e.code || e.message };
  }
}

async function checkTikTok(name) {
  if (isRL('tiktok')) return { rateLimited: true };
  try {
    const r = await axios.get(
      'https://www.tiktok.com/api/user/detail/?uniqueId=' + encodeURIComponent(name) + '&aid=1988',
      { httpsAgent: getProxyAgent(), proxy: false, timeout: TIMEOUT, headers: { 'User-Agent': UA, 'Referer': 'https://www.tiktok.com/' } }
    );
    return { available: !r.data.userInfo || !r.data.userInfo.user || !r.data.userInfo.user.id };
  } catch (e) {
    if (e.response && e.response.status === 429) { setRL('tiktok', 180000); return { rateLimited: true }; }
    if (e.response && e.response.status === 404) return { available: true };
    return { available: false, error: e.code || e.message };
  }
}

async function checkInstagram(name) {
  if (isRL('instagram')) return { rateLimited: true };
  try {
    const r = await axios.get(
      'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(name),
      { httpsAgent: getProxyAgent(), proxy: false, timeout: TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)', 'X-IG-App-ID': '936619743392459', 'Referer': 'https://www.instagram.com/' } }
    );
    return { available: !r.data.data || !r.data.data.user };
  } catch (e) {
    if (e.response && e.response.status === 429) { setRL('instagram', 300000); return { rateLimited: true }; }
    if (e.response && e.response.status === 404) return { available: true };
    return { available: false, error: e.code || e.message };
  }
}

const checkers = { roblox: checkRoblox, discord: checkDiscord, tiktok: checkTikTok, instagram: checkInstagram };

app.get('/check/:platform/:name', async (req, res) => {
  const platform = req.params.platform;
  const name = req.params.name;
  if (!checkers[platform]) return res.status(400).json({ error: 'Unknown platform' });
  const result = await checkers[platform](name);
  console.log('[' + platform + '] @' + name + ' ->', JSON.stringify(result));
  res.json(result);
});

app.post('/check-bulk', async (req, res) => {
  const names = req.body.names || [];
  const platforms = req.body.platforms || [];
  if (names.length > 100) return res.status(400).json({ error: 'Max 100 names' });
  const results = {};
  for (const name of names) {
    results[name] = {};
    for (const p of platforms) {
      if (checkers[p]) results[name][p] = await checkers[p](name);
    }
  }
  res.json(results);
});

app.get('/reload-proxies', (req, res) => {
  loadProxies();
  res.json({ ok: true, proxies: proxies.length });
});

app.get('/ping', (req, res) => {
  res.json({ ok: true, proxies: proxies.length, rateLimits: rateLimits, uptime: Math.floor(process.uptime()) + 's' });
});

app.get('/stats', (req, res) => {
  res.json({ proxies: proxies.length, rateLimits: rateLimits, uptime: Math.floor(process.uptime()) + 's' });
});

app.get('/', (req, res) => {
  res.json({ status: 'Username Sniper Backend running', proxies: proxies.length });
});

app.listen(PORT, function() {
  console.log('Username Sniper Backend running on port ' + PORT);
  loadProxies();
});
