// HTTP-сервер RSVP API. Роуты (JSON):
//   POST /api/rsvp/auth   {word}                  → {ok, names[]}
//   POST /api/rsvp/submit {secretWord, ...ответы} → {ok}
//   GET  /api/health                              → {ok, demo}
// Доступ — только через nginx сайта (location /api/), поэтому CORS не нужен.
import http from 'node:http';
import { config, demoMode } from './config.js';
import { findGuest } from './guests.js';
import { sanitizePayload, submit, startOutboxLoop, ensureSheetsAtStartup } from './rsvp.js';
import { ensureDataDir, journalAppend } from './store.js';
import { allow } from './ratelimit.js';

const BODY_LIMIT = 64 * 1024;

// X-Forwarded-For не трогаем: клиент может прислать свой и обойти лимитер
// (nginx лишь дописывает реальный IP в конец). X-Real-IP наш nginx выставляет
// сам ($remote_addr), затереть его снаружи нельзя.
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  return req.socket.remoteAddress || 'unknown';
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ответ в возможно уже разрушенный сокет (например после req.destroy при
// превышении лимита тела) не должен ронять процесс
function trySend(res, status, data) {
  try {
    if (!res.headersSent && res.socket && !res.socket.destroyed) send(res, status, data);
  } catch (e) {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(res, 200, { ok: true, demo: demoMode });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'method' });
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      trySend(res, e.message === 'body-too-large' ? 413 : 400, { ok: false, error: 'bad-json' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { ok: false, error: 'bad-json' });
      return;
    }
    const ip = clientIp(req);

    if (url.pathname === '/api/rsvp/auth') {
      if (!allow(ip, 'auth')) {
        send(res, 429, { ok: false, error: 'slow-down' });
        return;
      }
      const guest = await findGuest(body.word);
      if (!guest) {
        journalAppend({ type: 'auth-fail', ip, word: String(body.word || '').slice(0, 60) });
        send(res, 200, { ok: false });
        return;
      }
      send(res, 200, { ok: true, names: guest.names });
      return;
    }

    if (url.pathname === '/api/rsvp/submit') {
      if (!allow(ip, 'submit')) {
        send(res, 429, { ok: false, error: 'slow-down' });
        return;
      }
      const guest = await findGuest(body.secretWord);
      if (!guest) {
        send(res, 200, { ok: false, error: 'word' });
        return;
      }
      const rec = sanitizePayload(body, guest);
      if (!rec) {
        send(res, 200, { ok: false, error: 'payload' });
        return;
      }
      send(res, 200, await submit(rec));
      return;
    }

    send(res, 404, { ok: false, error: 'not-found' });
  } catch (e) {
    console.error('[server]', e);
    trySend(res, 500, { ok: false, error: 'internal' });
  }
});

ensureDataDir();
startOutboxLoop();
ensureSheetsAtStartup();
server.listen(config.port, () => {
  console.log('[server] RSVP API на :' + config.port + (demoMode ? ' (демо-режим)' : ''));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
