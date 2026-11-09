#!/usr/bin/env node
// Supert – lower-third controller for vMix / OBS.
// Zero dependencies: needs Node 22+ (built-in fetch + WebSocket client).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // LAN-reachable so vMix in a VM / other PC can load /overlay
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const ASSETS = path.join(DATA, 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

// ---------------------------------------------------------------- persistence
const DEFAULT_SETTINGS = {
  outputs: { browser: true, vmix: false, obs: false },
  autoHideSec: 0,
  animation: 'slide', // slide | fade | none (browser overlay only)
  vmix: {
    host: '127.0.0.1', port: 8088,
    input: 'LowerThird',        // title input name or number in vMix
    nameField: 'Name.Text',     // text layer names inside the GT title
    titleField: 'Title.Text',
    overlay: 1,                 // overlay channel 1-4
  },
  obs: {
    host: '127.0.0.1', port: 4455, password: '',
    scene: '',                  // blank = current program scene
    item: 'LowerThird',         // source/group that gets shown & hidden
    nameSource: 'LT Name',      // OBS text sources
    titleSource: 'LT Title',
  },
  layout: {                     // browser overlay: customer PNG + positioned text (1920x1080 canvas)
    bg: '',
    nameX: 260, nameY: 880, nameSize: 54, nameColor: '#ffffff', nameWeight: 700,
    titleX: 260, titleY: 950, titleSize: 34, titleColor: '#dddddd', titleWeight: 400,
    font: 'Helvetica Neue, Arial, sans-serif',
  },
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // atomic: a crash mid-write can't corrupt the show file
}
function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else out[k] = over[k];
  }
  return out;
}

const PEOPLE_FILE = path.join(DATA, 'people.json');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
let people = readJSON(PEOPLE_FILE, []);
let settings = deepMerge(DEFAULT_SETTINGS, readJSON(SETTINGS_FILE, {}));
let live = null; // { id, name, title } | null
let autoTimer = null;

const savePeople = () => writeJSON(PEOPLE_FILE, people);
const saveSettings = () => writeJSON(SETTINGS_FILE, settings);

// ---------------------------------------------------------------- SSE
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const state = () => ({ people, live, settings: publicSettings() });
// never echo the OBS password back to browsers (the overlay page is loaded in vMix/OBS too)
function publicSettings() {
  const s = JSON.parse(JSON.stringify(settings));
  s.obs.password = s.obs.password ? '********' : '';
  return s;
}

// ---------------------------------------------------------------- vMix
async function vmixCall(fn, params = {}) {
  const v = settings.vmix;
  let url = `http://${v.host}:${v.port}/api/?Function=${encodeURIComponent(fn)}`;
  for (const [k, val] of Object.entries(params)) url += `&${k}=${encodeURIComponent(val)}`; // %20 not '+', vMix is picky
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`vMix HTTP ${res.status}`);
}
const vmixOverlay = () => Math.min(4, Math.max(1, Number(settings.vmix.overlay) || 1));

async function vmixTake(p) {
  const v = settings.vmix;
  await vmixCall('SetText', { Input: v.input, SelectedName: v.nameField, Value: p.name });
  await vmixCall('SetText', { Input: v.input, SelectedName: v.titleField, Value: p.title });
  await vmixCall(`OverlayInput${vmixOverlay()}In`, { Input: v.input });
}
const vmixClear = () => vmixCall(`OverlayInput${vmixOverlay()}Out`);

// ---------------------------------------------------------------- OBS (obs-websocket v5)
const obs = {
  ws: null, ready: false, connecting: null, pending: new Map(), error: '',
  sig: '', // host:port:password the current socket was opened with

  connect() {
    const o = settings.obs;
    const sig = `${o.host}:${o.port}:${o.password}`;
    if (this.ws && this.sig !== sig) this.close(); // settings changed → reconnect
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.sig = sig;
    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; this.connecting = null; err ? reject(err) : resolve(); };
      const ws = new WebSocket(`ws://${o.host}:${o.port}`);
      this.ws = ws;
      const timer = setTimeout(() => { done(new Error('OBS connection timed out')); ws.close(); }, 4000);
      ws.onerror = () => { this.error = 'Cannot reach OBS WebSocket (is it enabled? Tools → WebSocket Server Settings)'; clearTimeout(timer); done(new Error(this.error)); };
      ws.onclose = () => {
        this.ready = false; this.ws = null;
        for (const [, p] of this.pending) p.reject(new Error('OBS disconnected'));
        this.pending.clear(); clearTimeout(timer); done(new Error(this.error || 'OBS closed the connection'));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.op === 0) { // Hello → Identify (with auth if required)
          const id = { rpcVersion: 1 };
          const a = msg.d.authentication;
          if (a) {
            const secret = crypto.createHash('sha256').update(o.password + a.salt).digest('base64');
            id.authentication = crypto.createHash('sha256').update(secret + a.challenge).digest('base64');
          }
          ws.send(JSON.stringify({ op: 1, d: id }));
        } else if (msg.op === 2) { // Identified
          this.ready = true; this.error = ''; clearTimeout(timer); done();
        } else if (msg.op === 7) { // RequestResponse
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          msg.d.requestStatus.result ? p.resolve(msg.d.responseData || {})
            : p.reject(new Error(`OBS: ${msg.d.requestStatus.comment || 'request failed'} (${msg.d.requestType})`));
        }
      };
      // OBS closes with code 4009 on bad password
      const prevClose = ws.onclose;
      ws.onclose = (e) => { if (e.code === 4009) this.error = 'OBS authentication failed (wrong password)'; prevClose(e); };
    });
    return this.connecting;
  },

  close() { try { this.ws && this.ws.close(); } catch {} this.ws = null; this.ready = false; },

  async request(requestType, requestData = {}) {
    await this.connect();
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`OBS timeout (${requestType})`)); }, 4000);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  },
};

async function obsScene() {
  if (settings.obs.scene) return settings.obs.scene;
  return (await obs.request('GetCurrentProgramScene')).currentProgramSceneName;
}
async function obsSetVisible(visible) {
  const sceneName = await obsScene();
  const { sceneItemId } = await obs.request('GetSceneItemId', { sceneName, sourceName: settings.obs.item });
  await obs.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: visible });
}
async function obsTake(p) {
  const o = settings.obs;
  await obs.request('SetInputSettings', { inputName: o.nameSource, inputSettings: { text: p.name }, overlay: true });
  await obs.request('SetInputSettings', { inputName: o.titleSource, inputSettings: { text: p.title }, overlay: true });
  await obsSetVisible(true);
}
const obsClear = () => obsSetVisible(false);

// ---------------------------------------------------------------- take / clear
const outputStatus = { vmix: '', obs: '' }; // last error per output ('' = ok)

async function runOutputs(action, p) {
  const jobs = [];
  if (settings.outputs.vmix) jobs.push(['vmix', action === 'take' ? vmixTake(p) : vmixClear()]);
  if (settings.outputs.obs) jobs.push(['obs', action === 'take' ? obsTake(p) : obsClear()]);
  const results = await Promise.allSettled(jobs.map(([, j]) => j));
  results.forEach((r, i) => { outputStatus[jobs[i][0]] = r.status === 'rejected' ? String(r.reason.message || r.reason) : ''; });
  return { ...outputStatus };
}

async function take(id) {
  const p = people.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error('Person not found'), { status: 404 });
  clearTimeout(autoTimer);
  live = { id: p.id, name: p.name, title: p.title };
  broadcast('live', live); // browser overlay updates immediately; hardware outputs follow
  const errors = await runOutputs('take', live);
  const sec = Number(settings.autoHideSec);
  if (sec > 0) autoTimer = setTimeout(() => clear().catch(() => {}), sec * 1000);
  broadcast('status', errors);
  return { live, errors };
}
async function clear() {
  clearTimeout(autoTimer);
  const prev = live;
  live = null;
  broadcast('live', null);
  const errors = await runOutputs('clear', prev);
  broadcast('status', errors);
  return { live, errors };
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json' };

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readJson = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString()) : {}; };
const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) return send(res, 403, 'Forbidden', 'text/plain'); // block ../ traversal
  fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // CSRF guard: a random web page open in the operator's browser must not be able to fire graphics.
  if (req.method !== 'GET' && req.headers.origin) {
    let o; try { o = new URL(req.headers.origin).host; } catch {}
    if (o !== req.headers.host) return send(res, 403, { error: 'Cross-origin request blocked' });
  }

  if (req.method === 'GET') {
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    if (p === '/api/state') return send(res, 200, { ...state(), outputStatus });
    if (p === '/overlay') return serveFile(res, PUBLIC, 'overlay.html');
    if (p.startsWith('/assets/')) return serveFile(res, ASSETS, decodeURIComponent(p.slice(8)));
    return serveFile(res, PUBLIC, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)));
  }

  // ---- people
  if (p === '/api/people' && req.method === 'POST') {
    const b = await readJson(req);
    const list = Array.isArray(b.people) ? b.people : [b]; // single add or bulk import
    const added = list.map((x) => ({ id: crypto.randomUUID(), name: clean(x.name), title: clean(x.title) })).filter((x) => x.name);
    people.push(...added); savePeople(); broadcast('people', people);
    return send(res, 200, added);
  }
  let m = p.match(/^\/api\/people\/([\w-]+)$/);
  if (m) {
    const i = people.findIndex((x) => x.id === m[1]);
    if (i < 0) return send(res, 404, { error: 'Not found' });
    if (req.method === 'PUT') {
      const b = await readJson(req);
      people[i] = { ...people[i], name: clean(b.name) || people[i].name, title: clean(b.title) };
      if (live && live.id === m[1]) live = { ...live, name: people[i].name, title: people[i].title }; // keep on-air copy honest
    } else if (req.method === 'DELETE') {
      people.splice(i, 1);
    } else return send(res, 405, { error: 'Method not allowed' });
    savePeople(); broadcast('people', people);
    return send(res, 200, people);
  }
  if (p === '/api/people-order' && req.method === 'POST') {
    const { ids } = await readJson(req);
    const byId = new Map(people.map((x) => [x.id, x]));
    const ordered = (ids || []).map((id) => byId.get(id)).filter(Boolean);
    people = [...ordered, ...people.filter((x) => !ordered.includes(x))];
    savePeople(); broadcast('people', people);
    return send(res, 200, people);
  }

  // ---- on-air control
  if (p === '/api/take' && req.method === 'POST') return send(res, 200, await take((await readJson(req)).id));
  if (p === '/api/clear' && req.method === 'POST') return send(res, 200, await clear());

  // ---- settings
  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readJson(req);
    if (b.obs && b.obs.password === '********') delete b.obs.password; // placeholder → keep stored password
    settings = deepMerge(settings, b);
    saveSettings(); broadcast('settings', publicSettings());
    return send(res, 200, publicSettings());
  }
  if (p === '/api/test/vmix' && req.method === 'POST') {
    try {
      const v = settings.vmix;
      const r = await fetch(`http://${v.host}:${v.port}/api/`, { signal: AbortSignal.timeout(2500) });
      const xml = await r.text();
      const inputs = [...xml.matchAll(/<input [^>]*?title="([^"]*)"/g)].map((x) => x[1]);
      return send(res, 200, { ok: true, inputs });
    } catch (e) { return send(res, 200, { ok: false, error: `Cannot reach vMix at ${settings.vmix.host}:${settings.vmix.port} – is Web Controller enabled?` }); }
  }
  if (p === '/api/test/obs' && req.method === 'POST') {
    try {
      const scenes = (await obs.request('GetSceneList')).scenes.map((s) => s.sceneName);
      return send(res, 200, { ok: true, scenes });
    } catch (e) { return send(res, 200, { ok: false, error: obs.error || e.message }); }
  }

  // ---- customer graphic upload (raw body, filename in query)
  if (p === '/api/upload' && req.method === 'POST') {
    const name = path.basename(url.searchParams.get('filename') || 'graphic.png').replace(/[^\w.\-]/g, '_');
    if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) return send(res, 400, { error: 'Images only (png, jpg, webp, gif, svg)' });
    fs.writeFileSync(path.join(ASSETS, name), await readBody(req, 25e6));
    return send(res, 200, { url: `/assets/${encodeURIComponent(name)}` });
  }

  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { if (!res.headersSent) send(res, e.status || 500, { error: e.message }); else res.end(); });
});
server.listen(PORT, HOST, () => {
  const os = require('os');
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  console.log(`\n  Supert lower thirds running\n`);
  console.log(`  Control panel : http://localhost:${PORT}`);
  console.log(`  Overlay (browser source for OBS / vMix) : http://${lan ? lan.address : 'localhost'}:${PORT}/overlay\n`);
});
