#!/usr/bin/env node
'use strict';

// Small same-origin host for Hoverslam and its verified daily leaderboard.
// Uses only Node built-ins; scores are replayed through the game's simulation.
const http = require('http');
const fs = require('fs');
const path = require('path');
const Sim = require('./src/sim.js');

const root = __dirname;
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const boardPath = path.join(dataDir, 'daily-scores.json');
const port = Math.max(1, Number(process.env.PORT) || 8080);
const host = process.env.HOST || '0.0.0.0';
const boards = new Map();
const limits = new Map();
let writes = Promise.resolve();

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function json(res, status, body) {
  const out = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(out);
}
function throttle(req, res) {
  const ip = req.socket.remoteAddress || 'unknown', now = Date.now(), rec = limits.get(ip) || { start: now, count: 0 };
  if (now - rec.start > 60000) { rec.start = now; rec.count = 0; }
  rec.count++; limits.set(ip, rec);
  if (rec.count > 50) { json(res, 429, { error: 'Too many requests. Try again in a minute.' }); return true; }
  return false;
}
function saveBoards() {
  writes = writes.catch(() => {}).then(async () => {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const tmp = boardPath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(Object.fromEntries(boards)), 'utf8');
    await fs.promises.rename(tmp, boardPath);
  });
  return writes;
}
async function loadBoards() {
  try {
    const data = JSON.parse(await fs.promises.readFile(boardPath, 'utf8'));
    Object.keys(data).forEach((date) => {
      if (validDate(date) && Array.isArray(data[date])) boards.set(date, data[date].filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.score)).map((e) => ({ name: normalizeName(e.name), score: Math.max(0, Math.floor(e.score)), submittedAt: typeof e.submittedAt === 'string' ? e.submittedAt : new Date(0).toISOString() })).slice(0, 100));
    });
  } catch (e) { if (e.code !== 'ENOENT') console.error('Could not read daily scores:', e.message); }
}
function normalizeName(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, ' ').slice(0, 16) || 'PILOT';
}
function board(date) {
  return (boards.get(date) || []).slice().sort((a, b) => b.score - a.score || a.submittedAt.localeCompare(b.submittedAt));
}
function verifyFlight(date, trace) {
  if (!Array.isArray(trace) || trace.length > 20000) throw new Error('Replay is too large.');
  const challenge = Sim.dailyChallenge(date);
  const sim = Sim.createSim(challenge.level, challenge.seed, { assist: true });
  let steps = 0;
  for (const pair of trace) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || pair[0] < 0 || pair[0] > 7 || !Number.isInteger(pair[1]) || pair[1] < 1 || pair[1] > 65535) throw new Error('Replay data is invalid.');
    steps += pair[1];
    if (steps > 50000) throw new Error('Flight time exceeds the daily limit.');
    const input = { left: !!(pair[0] & 1), right: !!(pair[0] & 2), thrust: pair[0] & 4 ? 1 : 0 };
    for (let n = 0; n < pair[1]; n++) {
      Sim.step(sim, input, Sim.DT);
      if (sim.status !== 'flying') break;
    }
    if (sim.status !== 'flying') break;
  }
  if (!sim.result || !sim.result.ok) throw new Error('This flight did not make a valid landing.');
  return { challenge, score: sim.result.score };
}
async function readBody(req) {
  let body = '', size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Request is too large.');
    body += chunk.toString('utf8');
  }
  return JSON.parse(body || '{}');
}
function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' })[ext] || 'application/octet-stream';
}
const server = http.createServer(async (req, res) => {
  if (throttle(req, res)) return;
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
  if (url.pathname === '/api/daily' && req.method === 'GET') {
    const date = url.searchParams.get('date');
    if (!validDate(date)) return json(res, 400, { error: 'Date must be YYYY-MM-DD.' });
    return json(res, 200, { date, entries: board(date).slice(0, 20) });
  }
  if (url.pathname === '/api/daily' && req.method === 'POST') {
    try {
      const body = await readBody(req), date = body.date;
      if (!validDate(date) || date !== new Date().toISOString().slice(0, 10)) return json(res, 400, { error: 'Only today’s UTC challenge accepts scores.' });
      const { challenge, score } = verifyFlight(date, body.trace);
      if (Number(body.seed) !== challenge.seed) return json(res, 400, { error: 'Challenge seed does not match today.' });
      const name = normalizeName(body.name), entries = board(date), key = name.toLowerCase();
      const previous = entries.find((e) => e.name.toLowerCase() === key);
      if (!previous || score > previous.score) {
        const next = entries.filter((e) => e.name.toLowerCase() !== key);
        next.push({ name, score, submittedAt: new Date().toISOString() });
        next.sort((a, b) => b.score - a.score || a.submittedAt.localeCompare(b.submittedAt));
        boards.set(date, next.slice(0, 100));
        await saveBoards();
      }
      return json(res, 200, { date, entry: previous && previous.score >= score ? previous : { name, score }, entries: board(date).slice(0, 20) });
    } catch (e) { return json(res, 400, { error: e.message || 'Could not verify flight.' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { return json(res, 400, { error: 'Bad path.' }); }
  const target = pathname === '/' ? path.join(publicDir, 'index.html') : path.resolve(publicDir, '.' + pathname);
  if (!target.startsWith(publicDir + path.sep) && target !== path.join(publicDir, 'index.html')) return json(res, 403, { error: 'Forbidden.' });
  let file = target;
  try {
    const st = await fs.promises.stat(file);
    if (st.isDirectory()) file = path.join(file, 'index.html');
    const data = await fs.promises.readFile(file);
    res.writeHead(200, { 'Content-Type': mime(file), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return res.end(data);
  } catch (e) {
    if (path.extname(pathname)) return json(res, 404, { error: 'Not found.' });
    try {
      const data = await fs.promises.readFile(path.join(publicDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      return req.method === 'HEAD' ? res.end() : res.end(data);
    } catch (missing) { return json(res, 503, { error: 'Run npm run build first.' }); }
  }
});

loadBoards().then(() => server.listen(port, host, () => console.log('Hoverslam listening on http://' + host + ':' + port)));
