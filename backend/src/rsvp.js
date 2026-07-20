// Бизнес-логика RSVP: валидация ответов и upsert строки в «Ответы на rsvp».
// Схема вкладки (по строке на анкету, повторная отправка обновляет строку):
//   A Секретное слово | B Гость 1 | C Гость 2 | D Приедут? | E Трансфер |
//   F Мест для попутчиков | G Ночёвка | H Оплата домика | I Заполнено? | J Обновлено
// D/E/G/H — тексты из белых списков (совпадают с выпадающими списками таблицы),
// I — boolean-чекбокс (true = анкета отправлена и залочена), «Сводка» считает всё
// формулами поверх этих колонок. Клиенту не верим: имена берём из списка гостей,
// значения — из белых списков.
import { config, demoMode } from './config.js';
import { valuesGet, valuesGetFormula, valuesUpdate, valuesAppend, listSheetTitles, addSheet, sheetRange } from './sheets.js';
import { journalAppend, outboxPut, outboxRemoveById, outboxRead, photoOutboxPut, photoOutboxRead, photoOutboxRemoveById } from './store.js';
import { normWord } from './guests.js';

export const ANSWER_HEADERS = [
  'Секретное слово', 'Гость 1', 'Гость 2', 'Приедут?', 'Трансфер',
  'Мест для попутчиков', 'Ночёвка', 'Оплата домика', 'Заполнено?', 'Обновлено',
  'Фото Гость 1', 'Фото Гость 2', // K/L: =IMAGE(url) — миниатюра + прямая ссылка
];

// K (guestIndex 0) / L (guestIndex 1) — колонки со ссылками на фото
const PHOTO_COL = ['K', 'L'];
const IMG_URL_RE = /=IMAGE\("([^"]+)"/i;

export function sanitizePayload(raw, guest) {
  let come = ['yes', 'no', 'both', 'onlyA', 'onlyB'].includes(raw.comeAnswer) ? raw.comeAnswer : null;
  if (!come) return null;
  // клиенту не верим: приводим ответ к составу гостя, иначе «Приедут?»/«Сводка» врут
  const couple = guest.names.length > 1;
  if (!couple && come !== 'no') come = 'yes';       // одиночке — только «приду / не приду»
  if (couple && come === 'yes') come = 'both';      // «yes» бывает лишь у одиночки
  const isComing = come !== 'no';
  const names = guest.names;
  let attending = [];
  if (isComing) {
    attending = come === 'onlyA' ? [names[0]]
      : come === 'onlyB' ? [names[1] || names[0]]
      : names.slice();
  }
  let transfer = null;
  let overnight = null;
  if (isComing) {
    const mode = raw.transfer && ['need', 'self'].includes(raw.transfer.mode) ? raw.transfer.mode : null;
    const seats = mode === 'self'
      ? Math.max(0, Math.min(7, parseInt(raw.transfer && raw.transfer.seatsOffered, 10) || 0))
      : 0;
    transfer = { mode, seatsOffered: seats };
    const staying = !!(raw.overnight && raw.overnight.staying);
    const pay = staying && raw.overnight && ['me', 'them'].includes(raw.overnight.housePayment)
      ? raw.overnight.housePayment : null;
    overnight = { staying, housePayment: pay };
  }
  return {
    word: guest.word,
    guests: names,
    attending,
    isComing,
    comeAnswer: come,
    transfer,
    overnight,
    submittedAt: typeof raw.submittedAt === 'string' ? raw.submittedAt.slice(0, 40) : '',
  };
}

function tbilisiNow() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Tbilisi',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

// «Приедут?» — тексты выпадающего списка колонки D. У одиночного гостя «да» = «Да,
// Гость 1»; у пары есть «Да, оба» и раздельные «только он / только она».
function comeCell(rec) {
  if (!rec.isComing) return 'Нет';
  switch (rec.comeAnswer) {
    case 'both': return 'Да, оба';
    case 'onlyA': return 'Да, Гость 1';
    case 'onlyB': return 'Да, Гость 2';
    default: return 'Да, Гость 1'; // 'yes' — одиночный гость
  }
}

function toRow(rec) {
  const t = rec.transfer || {};
  const o = rec.overnight || {};
  const coming = rec.isComing;
  const g = rec.guests || [];
  return [
    rec.word,                                                 // A Секретное слово
    g[0] || '',                                               // B Гость 1
    g[1] || '',                                               // C Гость 2
    comeCell(rec),                                            // D Приедут?
    !coming ? '' : t.mode === 'need' ? 'Нужен' : t.mode === 'self' ? 'Не нужен' : '', // E Трансфер
    !coming || t.mode !== 'self' ? '' : t.seatsOffered,       // F Мест для попутчиков
    !coming ? '' : o.staying ? 'Остаюсь' : 'Не остаюсь',      // G Ночёвка
    !coming || !o.staying ? '' : o.housePayment === 'me' ? 'Заплачу' : o.housePayment === 'them' ? 'Не заплачу' : '', // H Оплата домика
    true,                                                     // I Заполнено? (отправка = замок)
    tbilisiNow(),                                             // J Обновлено (Тбилиси)
  ];
}

// Разбор строки таблицы обратно в состояние анкеты (для гидрации фронтенда при
// заходе гостя). couple важен: «Да, Гость 1» у одиночки = 'yes', у пары = 'onlyA'.
export function parseAnswerRow(row, guest) {
  const couple = guest.names.length > 1;
  const s = (i) => String(row[i] == null ? '' : row[i]).trim();
  const d = s(3);
  const come = d === 'Нет' ? 'no'
    : d === 'Да, оба' ? 'both'
    : d === 'Да, Гость 1' ? (couple ? 'onlyA' : 'yes')
    : d === 'Да, Гость 2' ? 'onlyB'
    : null;
  const e = s(4);
  const transfer = e === 'Нужен' ? 'need' : e === 'Не нужен' ? 'self' : null;
  const seatsN = parseInt(row[5], 10);
  const seats = Number.isFinite(seatsN) ? Math.max(0, Math.min(7, seatsN)) : 0;
  const g = s(6);
  const stay = g === 'Остаюсь' ? 'yes' : g === 'Не остаюсь' ? 'no' : null;
  const h = s(7);
  const pay = h === 'Заплачу' ? 'me' : h === 'Не заплачу' ? 'them' : null;
  const locked = row[8] === true || String(row[8]).trim().toLowerCase() === 'true';
  return { comeAnswer: come, transfer, seats, stay, pay, locked };
}

// Ответ гостя из таблицы: { answers|null, locked }. answers=null, если строки нет
// или в ней ещё не выбран пункт «Приедут?» (гостю показываем обычный флоу).
export async function readGuestAnswer(guest) {
  if (demoMode) return { answers: null, locked: false };
  try {
    await ensureSheets();
    const rows = await valuesGet(sheetRange(config.answersSheet, 'A2:J'), true);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (normWord(row[0]) === guest.word) {
        // фото из K/L читаем формулами: в ячейке лежит =IMAGE("url") — вытаскиваем url
        const photo = await readPhotoUrls(i + 2).catch(() => ({ photoA: null, photoB: null }));
        const p = parseAnswerRow(row, guest);
        // замок засчитываем только при валидном «Приедут?»: галочка на пустой/битой
        // строке (ручная правка) не должна запирать гостя на фиктивном ответе
        const has = p.comeAnswer != null;
        // фото отдаём всегда (грузится отдельным эндпоинтом, замка не касается)
        return { answers: (has || photo.photoA || photo.photoB) ? { ...p, ...photo } : null, locked: has && p.locked };
      }
    }
  } catch (e) {
    console.error('[rsvp] не удалось прочитать ответ гостя:', e.message);
  }
  return { answers: null, locked: false };
}

// url'ы фото из ячеек K/L конкретной строки (формула =IMAGE("url"))
async function readPhotoUrls(rowNum) {
  const rows = await valuesGetFormula(sheetRange(config.answersSheet, 'K' + rowNum + ':L' + rowNum));
  const cells = rows[0] || [];
  const pick = (v) => { const m = IMG_URL_RE.exec(String(v || '')); return m ? m[1] : null; };
  return { photoA: pick(cells[0]), photoB: pick(cells[1]) };
}

// Все записи в таблицу идут по одной — последовательная очередь вместо гонок
let chain = Promise.resolve();
function serialized(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

let ensured = false;
async function ensureSheets() {
  if (ensured) return;
  const titles = await listSheetTitles();
  if (!titles.includes(config.answersSheet)) {
    await addSheet(config.answersSheet);
    await valuesAppend(sheetRange(config.answersSheet, 'A1'), [ANSWER_HEADERS]);
  }
  ensured = true;
}

async function upsertRow(rec) {
  await ensureSheets();
  const col = await valuesGet(sheetRange(config.answersSheet, 'A2:A'));
  for (let i = 0; i < col.length; i++) {
    if (normWord(col[i][0]) === rec.word) {
      await valuesUpdate(sheetRange(config.answersSheet, 'A' + (i + 2) + ':J' + (i + 2)), [toRow(rec)]);
      return;
    }
  }
  await valuesAppend(sheetRange(config.answersSheet, 'A1'), [toRow(rec)]);
}

// Запись ссылки на фото в ячейку K/L строки гостя. Значение — формула
// =IMAGE("url") (USER_ENTERED), поэтому в таблице видна миниатюра, а сам url
// доступен в строке формул. Пустая строка очищает ячейку («убрать фото»).
async function writePhotoUrl(word, guestIndex, url) {
  await ensureSheets();
  const col = await valuesGet(sheetRange(config.answersSheet, 'A2:A'));
  const w = normWord(word);
  const cell = PHOTO_COL[guestIndex] || PHOTO_COL[0];
  const value = url ? '=IMAGE("' + String(url).replace(/"/g, '') + '")' : '';
  for (let i = 0; i < col.length; i++) {
    if (normWord(col[i][0]) === w) {
      await valuesUpdate(sheetRange(config.answersSheet, cell + (i + 2)), [[value]], 'USER_ENTERED');
      return true;
    }
  }
  return false; // строки гостя нет (не должно случаться — слово из списка приглашённых)
}

// Публичная точка: сохранить/очистить ссылку на фото в таблице. Демо — только
// журнал. При сбое таблицы кладём в фото-outbox (файл уже сохранён и раздаётся).
export async function submitPhotoCell(word, guestIndex, url) {
  journalAppend({ type: 'photo', demo: demoMode, word, guestIndex, url: url || '' });
  if (demoMode) return { ok: true, demo: true };
  try {
    await serialized(() => writePhotoUrl(word, guestIndex, url));
    return { ok: true };
  } catch (e) {
    console.error('[rsvp] запись фото в таблицу не удалась, кладём в outbox:', e.message);
    photoOutboxPut({ word, guestIndex, url: url || '' });
    return { ok: true, queued: true };
  }
}

let flushingPhoto = false;
async function flushPhotoOutbox() {
  if (demoMode || flushingPhoto) return;
  flushingPhoto = true;
  try {
    for (const e of photoOutboxRead()) {
      try {
        await serialized(() => writePhotoUrl(e.word, e.guestIndex, e.url));
        photoOutboxRemoveById(e.qid);
        console.log('[rsvp] дослали фото в таблицу:', e.word, e.guestIndex);
      } catch (err) {
        console.error('[rsvp] таблица недоступна, фото остаётся в outbox:', err.message);
        return;
      }
    }
  } finally {
    flushingPhoto = false;
  }
}

let flushing = false;
async function flushOutbox() {
  if (demoMode || flushing) return;
  flushing = true;
  try {
    for (const entry of outboxRead()) {
      try {
        await serialized(() => upsertRow(entry.rec));
        outboxRemoveById(entry.qid);
        console.log('[rsvp] дослали в таблицу:', entry.rec.word);
      } catch (e) {
        console.error('[rsvp] таблица недоступна, оставляем в outbox:', e.message);
        return; // порядок сохраняем, попробуем в следующий раз
      }
    }
  } finally {
    flushing = false;
  }
}

export function startOutboxLoop() {
  if (demoMode) return;
  setInterval(function () { flushOutbox(); flushPhotoOutbox(); }, 30 * 1000).unref();
  flushOutbox();
  flushPhotoOutbox();
}

// Вкладку готовим сразу при старте: без «Ответы на rsvp» не пройдёт ни один auth
// (это же список приглашённых), а до submit дело иначе не дойдёт.
export async function ensureSheetsAtStartup() {
  if (demoMode) return;
  try {
    await serialized(() => ensureSheets());
    console.log('[rsvp] вкладка ответов на месте:', config.answersSheet);
  } catch (e) {
    console.error('[rsvp] не удалось подготовить таблицу (повторим при первом submit):', e.message);
  }
}

// Ответ гостя: журнал → таблица; если таблица недоступна — в outbox с ретраями.
export async function submit(rec) {
  journalAppend({ type: 'submit', demo: demoMode, record: rec });
  if (demoMode) {
    console.log('[demo] RSVP submit:', JSON.stringify(rec));
    return { ok: true, demo: true };
  }
  // записи этого слова, лежавшие в outbox до нас, устаревают: свежий ответ
  // сейчас поедет в таблицу напрямую, и догонять его старым нельзя
  const stale = outboxRead().filter((e) => e.rec.word === rec.word).map((e) => e.qid);
  try {
    await serialized(() => upsertRow(rec));
    if (stale.length) outboxRemoveById(stale);
    return { ok: true };
  } catch (e) {
    console.error('[rsvp] запись в таблицу не удалась, кладём в outbox:', e.message);
    outboxPut(rec);
    // с точки зрения гостя всё ок: ответ зафиксирован и доедет ретраем
    return { ok: true, queued: true };
  }
}
