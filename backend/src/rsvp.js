// Бизнес-логика RSVP: валидация ответов и upsert строки в «Ответы на rsvp».
// Схема вкладки (по строке на анкету, повторная отправка обновляет строку):
//   A Секретное слово | B Гость 1 | C Гость 2 | D Приедут? | E Трансфер |
//   F Мест для попутчиков | G Ночёвка | H Оплата домика | I Заполнено? | J Обновлено
// D/E/G/H — тексты из белых списков (совпадают с выпадающими списками таблицы),
// I — boolean-чекбокс (true = анкета отправлена и залочена), «Сводка» считает всё
// формулами поверх этих колонок. Клиенту не верим: имена берём из списка гостей,
// значения — из белых списков.
import { config, demoMode } from './config.js';
import { valuesGet, valuesUpdate, valuesAppend, listSheetTitles, addSheet, sheetRange } from './sheets.js';
import { journalAppend, outboxPut, outboxRemoveById, outboxRead } from './store.js';
import { normWord } from './guests.js';

export const ANSWER_HEADERS = [
  'Секретное слово', 'Гость 1', 'Гость 2', 'Приедут?', 'Трансфер',
  'Мест для попутчиков', 'Ночёвка', 'Оплата домика', 'Заполнено?', 'Обновлено',
];

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
    for (const row of rows) {
      if (normWord(row[0]) === guest.word) {
        const p = parseAnswerRow(row, guest);
        // замок засчитываем только при валидном «Приедут?»: галочка на пустой/битой
        // строке (ручная правка) не должна запирать гостя на фиктивном ответе
        const has = p.comeAnswer != null;
        return { answers: has ? p : null, locked: has && p.locked };
      }
    }
  } catch (e) {
    console.error('[rsvp] не удалось прочитать ответ гостя:', e.message);
  }
  return { answers: null, locked: false };
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
  if (!titles.includes(config.guestsSheet)) {
    await addSheet(config.guestsSheet);
    await valuesAppend(sheetRange(config.guestsSheet, 'A1'),
      [['Секретное слово', 'Имя 1', 'Имя 2 (для пары)', 'Комментарий']]);
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
  setInterval(flushOutbox, 30 * 1000).unref();
  flushOutbox();
}

// Вкладки готовим сразу при старте: без «Гости» не пройдёт ни один auth,
// а до submit (где ensureSheets тоже зовётся) дело иначе не дойдёт.
export async function ensureSheetsAtStartup() {
  if (demoMode) return;
  try {
    await serialized(() => ensureSheets());
    console.log('[rsvp] вкладки таблицы на месте:', config.guestsSheet, '/', config.answersSheet);
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
