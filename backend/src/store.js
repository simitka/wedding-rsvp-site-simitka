// Локальное хранилище: журнал всех сабмитов (jsonl, страховка на случай проблем
// с таблицей) и outbox — очередь записей, которые ещё не доехали до Google Sheets.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const journalPath = () => path.join(config.dataDir, 'answers.log.jsonl');
const outboxPath = () => path.join(config.dataDir, 'outbox.json');
const guestsCachePath = () => path.join(config.dataDir, 'guests-cache.json');

export function ensureDataDir() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
  } catch (e) {
    console.error('[store] не удалось создать DATA_DIR:', e.message);
  }
}

export function journalAppend(record) {
  try {
    fs.appendFileSync(journalPath(), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  } catch (e) {
    console.error('[store] журнал недоступен:', e.message);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('[store] не удалось записать', file, e.message);
  }
}

// Записи outbox: { qid, rec }. Удаляем по qid, а не по слову: пока flush
// отправлял старую запись, гость мог положить новую с тем же словом —
// её терять нельзя.
let qseq = 0;

export function outboxRead() {
  return readJson(outboxPath(), []);
}

// В outbox держим по одной (последней) записи на секретное слово — ответы упсертятся
export function outboxPut(rec) {
  const qid = Date.now().toString(36) + '-' + (++qseq);
  const box = outboxRead().filter((e) => e.rec.word !== rec.word);
  box.push({ qid, rec });
  writeJsonAtomic(outboxPath(), box);
  return qid;
}

export function outboxRemoveById(qids) {
  const drop = new Set(Array.isArray(qids) ? qids : [qids]);
  writeJsonAtomic(outboxPath(), outboxRead().filter((e) => !drop.has(e.qid)));
}

export function guestsCacheRead() {
  return readJson(guestsCachePath(), null);
}

export function guestsCacheWrite(guests) {
  writeJsonAtomic(guestsCachePath(), guests);
}
