require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_KEY = process.env.TMDB_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const MOONLIGHT_URL = process.env.MOONLIGHT_URL;
const STREAMO_ORIGIN = process.env.STREAMO_ORIGIN;
const TOKEN_FILE = path.join(__dirname, 'tokens.json');

if (!TMDB_KEY) { console.error('ERROR: TMDB_KEY not set. Copy .env.example to .env and fill in your values.'); process.exit(1); }

// --- Token Cache ---
let moonlightToken = null;
let moonlightExpiry = 0;
const kenmaTokens = new Map();
let serverList = null;
let serverListExpiry = 0;

// Load tokens from file (shared between token-helper and server)
function loadTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (data.moonlight && data.moonlightExpiry > Date.now() + 60000) {
      moonlightToken = data.moonlight;
      moonlightExpiry = data.moonlightExpiry;
      console.log('[Token] Loaded moonlight token from file, expires in ' + Math.round((moonlightExpiry - Date.now()) / 1000) + 's');
    }
    if (data.kenma) {
      for (const [k, v] of Object.entries(data.kenma)) {
        if (v.expiry > Date.now() + 30000) kenmaTokens.set(k, v);
      }
    }
  } catch {}
}

function saveTokens() {
  const kenmaObj = {};
  for (const [k, v] of kenmaTokens) kenmaObj[k] = v;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    moonlight: moonlightToken,
    moonlightExpiry,
    kenma: kenmaObj,
  }));
}

// Watch tokens.json for updates from token-helper
fs.watchFile(TOKEN_FILE, { interval: 2000 }, () => {
  console.log('[Token] tokens.json changed, reloading...');
  loadTokens();
});

async function getMoonlightToken() {
  if (moonlightToken && Date.now() < moonlightExpiry - 120000) return moonlightToken;
  loadTokens();
  if (moonlightToken && Date.now() < moonlightExpiry - 120000) return moonlightToken;
  throw new Error('Moonlight token expired. Run token-helper on a machine with a browser.');
}

async function getKenmaToken(workerBase) {
  const cached = kenmaTokens.get(workerBase);
  if (cached && Date.now() < cached.expiry - 60000) return cached.token;

  // Kenma tokens can be fetched server-side via streamotv.org (no Turnstile needed)
  console.log('[Kenma] Fetching token for ' + workerBase + '...');
  const resp = await fetch(STREAMO_ORIGIN + '/api/kenma-token?server=' + encodeURIComponent(workerBase), {
    headers: { 'Referer': STREAMO_ORIGIN + '/', 'Origin': STREAMO_ORIGIN }
  });

  if (!resp.ok) throw new Error('Kenma token fetch failed: ' + resp.status);
  const result = await resp.json();

  if (result.token) {
    kenmaTokens.set(workerBase, {
      token: result.token,
      expiry: Date.now() + (result.expiresIn || 900) * 1000
    });
    saveTokens();
    console.log('[Kenma] OK, expires in ' + result.expiresIn + 's');
    return result.token;
  }
  throw new Error(result.error || 'Kenma token failed');
}

async function getStreamoServers() {
  if (serverList && Date.now() < serverListExpiry) return serverList;

  const token = await getMoonlightToken();
  console.log('[Servers] Fetching from Convex...');

  const resp = await fetch(MOONLIGHT_URL + '/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': token },
    body: JSON.stringify({ path: 'settings:getStreamoServers', args: {} })
  });
  const data = await resp.json();

  if (data.status === 'success' && data.value) {
    serverList = data.value.filter(s => !s.locked && s.urls && s.urls.length > 0);
    serverListExpiry = Date.now() + 10 * 60 * 1000;
    console.log('[Servers] Got ' + serverList.length + ' free servers');
    return serverList;
  }
  throw new Error('Failed to get servers');
}

// --- Middleware ---
app.use(express.json());

// --- Token Management ---
app.get('/token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'token.html'));
});

app.get('/api/config', (req, res) => {
  res.json({ turnstileSitekey: process.env.TURNSTILE_SITEKEY, streamoOrigin: STREAMO_ORIGIN });
});

app.post('/api/token', (req, res) => {
  const t = req.body;
  if (!t || !t.token) return res.status(400).json({ error: 'no token' });
  moonlightToken = t.token;
  moonlightExpiry = Date.now() + (t.expiresIn || 7200) * 1000;
  serverList = null;
  saveTokens();
  console.log('[Token] Received via /token page, expires in ' + t.expiresIn + 's');
  res.json({ ok: true, minutes: Math.round(t.expiresIn / 60) });
});

app.get('/api/token-status', (req, res) => {
  const left = moonlightToken && moonlightExpiry > Date.now() ? Math.round((moonlightExpiry - Date.now()) / 60000) : 0;
  res.json({ valid: left > 2, minutes: left });
});

// --- TMDB Proxy ---
app.use('/api/tmdb', async (req, res) => {
  const tmdbPath = req.url.split('?')[0].replace(/^\//, '');
  const qs = new URLSearchParams(req.query);
  qs.set('api_key', TMDB_KEY);
  qs.set('include_adult', 'false');
  try {
    const resp = await fetch(TMDB_BASE + '/' + tmdbPath + '?' + qs);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Servers ---
app.get('/api/servers', async (req, res) => {
  try { res.json(await getStreamoServers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Streams ---
app.get('/api/streams/:server/:type/:id', async (req, res) => {
  const { server, type, id } = req.params;
  const { season, episode } = req.query;
  try {
    const servers = await getStreamoServers();
    const srv = servers.find(s => s.name.toLowerCase() === server.toLowerCase());
    if (!srv) return res.status(404).json({ error: 'Server not found' });

    const urlTemplate = srv.urls[Math.floor(Math.random() * srv.urls.length)];
    const workerBase = urlTemplate.match(/^https:\/\/[^/]+/)[0];
    const mediaType = type === 'tv' ? 'series' : 'movie';
    let streamUrl = urlTemplate.replace('{type}', mediaType).replace('{id}', id);
    if (season && episode) streamUrl += '?season=' + season + '&episode=' + episode;

    const token = await getKenmaToken(workerBase);
    const resp = await fetch(streamUrl, { headers: { 'Authorization': 'Bearer ' + token } });
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Subtitles ---
app.get('/api/subtitles/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const { season, episode } = req.query;
  try {
    const servers = await getStreamoServers();
    const workerBase = servers[0].urls[0].match(/^https:\/\/[^/]+/)[0];
    const mediaType = type === 'tv' ? 'series' : 'movie';
    let url = workerBase + '/api/subtitles/' + mediaType + '/' + id;
    if (season && episode) url += '?season=' + season + '&episode=' + episode;
    const resp = await fetch(url);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Static files (only serve actual files, not SPA fallback for /api/) ---
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// --- SPA fallback (skip /api/ paths) ---
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n  StreamoTV running on http://0.0.0.0:' + PORT + '\n');
  loadTokens();
  (async () => {
    try {
      await getMoonlightToken();
      await getStreamoServers();
      console.log('  Ready! Tokens loaded.\n');
    } catch (e) {
      console.log('  Open http://<IP>:' + PORT + '/token on any device to activate streaming');
    }
  })();
});
