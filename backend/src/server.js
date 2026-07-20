// HTTP-сервер RSVP API. Роуты (JSON):
//   POST /api/rsvp/auth   {word}                  → {ok, names[], answers, locked}
//   POST /api/rsvp/submit {secretWord, ...ответы} → {ok}
//   POST /api/rsvp/photo?word=..&g=0|1  (raw img) → {ok, url}      (загрузка фото)
//   POST /api/rsvp/photo/clear {word, g}          → {ok}           (убрать фото)
//   GET  /api/rsvp/photo/<file>.png               → сам PNG        (прямая ссылка)
//   GET  /api/health                              → {ok, demo}
// Загрузка/очистка фото гейтятся секретным словом (findGuest) — принимаем только
// от приглашённых. Доступ к API — только через nginx сайта (location /api/).
import http from 'node:http';
import fs from 'node:fs';
import { config, demoMode } from './config.js';
import { findGuest } from './guests.js';
import { sanitizePayload, submit, startOutboxLoop, ensureSheetsAtStartup, readGuestAnswer, submitPhotoCell } from './rsvp.js';
import { savePhoto, clearPhoto, photoFilePath, ensurePhotosDir, PHOTO_MAX_BYTES } from './photos.js';
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

// собираем тело в Buffer с потолком (raw — для фото; json оборачивает поверх)
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req) {
  return (await readRawBody(req, BODY_LIMIT)).toString('utf8');
}

// отдача PNG по прямой ссылке /api/rsvp/photo/<file>. Имя строго валидируем в
// photoFilePath (только наши [a-f0-9-].png) — обхода каталога быть не может.
function servePhoto(res, filename) {
  const fp = photoFilePath(filename);
  if (!fp) { res.writeHead(400).end(); return; }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    const stream = fs.createReadStream(fp);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(res, 200, { ok: true, demo: demoMode });
      return;
    }
    // прямая ссылка на фото — отдаём файл (публично, за неугадываемым именем)
    if (req.method === 'GET' && url.pathname.startsWith('/api/rsvp/photo/')) {
      servePhoto(res, decodeURIComponent(url.pathname.slice('/api/rsvp/photo/'.length)));
      return;
    }

    // загрузка фото: тело — сырые байты картинки (любой формат), гейт по слову
    if (req.method === 'POST' && url.pathname === '/api/rsvp/photo') {
      const ip = clientIp(req);
      if (!allow(ip, 'photo')) { send(res, 429, { ok: false, error: 'slow-down' }); return; }
      const guest = await findGuest(url.searchParams.get('word'));
      if (!guest) { send(res, 200, { ok: false, error: 'word' }); return; }        // гейт
      const g = parseInt(url.searchParams.get('g'), 10) === 1 ? 1 : 0;
      if (g === 1 && guest.names.length < 2) { send(res, 200, { ok: false, error: 'guest' }); return; }
      let buf;
      try { buf = await readRawBody(req, PHOTO_MAX_BYTES); }
      catch (e) { trySend(res, e.message === 'body-too-large' ? 413 : 400, { ok: false, error: 'too-large' }); return; }
      if (!buf.length) { send(res, 200, { ok: false, error: 'empty' }); return; }
      let saved;
      try { saved = await savePhoto(guest.word, g, buf); }
      catch (e) { console.error('[photo] конвертация не удалась:', e.message); send(res, 200, { ok: false, error: 'convert' }); return; }
      await submitPhotoCell(guest.word, g, saved.url);
      send(res, 200, { ok: true, url: saved.url });
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
      // отдаём сохранённые ответы + флаг замка: фронтенд по ним решает экран
      // (замок → read-only, всё заполнено → чек, иначе → незаполненный шаг)
      const state = await readGuestAnswer(guest);
      send(res, 200, { ok: true, names: guest.names, answers: state.answers, locked: state.locked });
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

    // убрать фото: чистим файл и ячейку таблицы (гейт по слову)
    if (url.pathname === '/api/rsvp/photo/clear') {
      if (!allow(ip, 'photo')) { send(res, 429, { ok: false, error: 'slow-down' }); return; }
      const guest = await findGuest(body.word);
      if (!guest) { send(res, 200, { ok: false, error: 'word' }); return; }
      const g = parseInt(body.g, 10) === 1 ? 1 : 0;
      await clearPhoto(guest.word, g).catch(() => {});
      await submitPhotoCell(guest.word, g, '');
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { ok: false, error: 'not-found' });
  } catch (e) {
    console.error('[server]', e);
    trySend(res, 500, { ok: false, error: 'internal' });
  }
});

ensureDataDir();
ensurePhotosDir();
startOutboxLoop();
ensureSheetsAtStartup();
server.listen(config.port, () => {
  console.log('[server] RSVP API на :' + config.port + (demoMode ? ' (демо-режим)' : ''));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
