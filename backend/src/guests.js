// Список приглашённых берём из «Ответы на rsvp» (A секретное слово | B Гость 1 |
// D Гость 2 — между ними столбцы фото C/E) — та же вкладка, куда пишутся ответы;
// отдельной «Гости» больше нет. Кешируется в памяти и на диске — если таблица
// моргнула, анкета не ложится.
import { config, demoMode } from './config.js';
import { valuesGet, sheetRange } from './sheets.js';
import { guestsCacheRead, guestsCacheWrite } from './store.js';

const DEMO_GUESTS = [
  { word: 'хинкали', names: ['Саша'] },
  { word: 'сациви', names: ['Маша', 'Дима'] },
];

let cache = { at: 0, list: null };

export function normWord(w) {
  return String(w || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
}

async function fetchGuests() {
  // A слово | B Гость 1 | C Фото 1 | D Гость 2 | E Фото 2 — имена в B и D
  const rows = await valuesGet(sheetRange(config.answersSheet, 'A2:E'));
  const guests = [];
  for (const row of rows) {
    const word = normWord(row[0]);
    if (!word) continue;
    const names = [row[1], row[3]].map((v) => String(v || '').trim()).filter(Boolean);
    if (names.length) guests.push({ word, names });
  }
  return guests;
}

export async function getGuests() {
  if (demoMode) return DEMO_GUESTS;
  const now = Date.now();
  if (cache.list && now - cache.at < config.guestsTtlMs) return cache.list;
  try {
    const guests = await fetchGuests();
    cache = { at: now, list: guests };
    guestsCacheWrite(guests);
    return guests;
  } catch (e) {
    console.error('[guests] не удалось прочитать таблицу:', e.message);
    if (cache.list) return cache.list;
    const disk = guestsCacheRead();
    if (disk) {
      cache = { at: now, list: disk };
      return disk;
    }
    return [];
  }
}

export async function findGuest(word) {
  const w = normWord(word);
  if (!w) return null;
  const guests = await getGuests();
  return guests.find((g) => normWord(g.word) === w) || null;
}
