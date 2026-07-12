// Бизнес-логика RSVP: валидация ответов и upsert строки в «Ответы на rsvp».
// Клиенту не верим: имена берём из списка гостей, значения — из белых списков.
import { config, demoMode } from './config.js';
import { valuesGet, valuesUpdate, valuesAppend, listSheetTitles, addSheet, sheetRange } from './sheets.js';
import { journalAppend, outboxPut, outboxRemoveById, outboxRead } from './store.js';

export const ANSWER_HEADERS = [
  'Секретное слово', 'Гости', 'Придут?', 'Кто именно', 'Трансфер',
  'Мест для попутчиков', 'Ночёвка', 'Оплата домика', 'Обновлено', 'Отправлено раз', 'JSON',
];

export function sanitizePayload(raw, guest) {
  const come = ['yes', 'no', 'both', 'onlyA', 'onlyB'].includes(raw.comeAnswer) ? raw.comeAnswer : null;
  if (!come) return null;
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

function toRow(rec, submitCount) {
  const t = rec.transfer || {};
  const o = rec.overnight || {};
  return [
    rec.word,
    rec.guests.join(' и '),
    rec.isComing ? 'да' : 'нет',
    rec.attending.length ? rec.attending.join(' и ') : '—',
    !rec.isComing ? '—' : t.mode === 'need' ? 'нужен трансфер' : t.mode === 'self' ? 'сам за рулём' : '—',
    !rec.isComing ? '' : t.mode === 'self' ? String(t.seatsOffered) : '',
    !rec.isComing ? '—' : o.staying ? 'остаются ночевать' : 'уедут в ночь',
    !rec.isComing ? '—' : !o.staying ? '—'
      : o.housePayment === 'me' ? 'оплатят сами'
      : o.housePayment === 'them' ? 'за счёт молодожёнов' : '—',
    tbilisiNow(),
    String(submitCount),
    JSON.stringify(rec),
  ];
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
  } else {
    const head = await valuesGet(sheetRange(config.answersSheet, 'A1:A1'));
    if (!head.length) await valuesAppend(sheetRange(config.answersSheet, 'A1'), [ANSWER_HEADERS]);
  }
  if (!titles.includes(config.guestsSheet)) {
    await addSheet(config.guestsSheet);
    await valuesAppend(sheetRange(config.guestsSheet, 'A1'), [
      ['Секретное слово', 'Имя 1', 'Имя 2 (для пары)'],
      ['хинкали', 'Саша', ''],
      ['сациви', 'Маша', 'Дима'],
    ]);
  }
  ensured = true;
}

async function upsertRow(rec) {
  await ensureSheets();
  const col = await valuesGet(sheetRange(config.answersSheet, 'A2:J'));
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0] || '').trim() === rec.word) {
      const count = (parseInt(col[i][9], 10) || 0) + 1;
      await valuesUpdate(sheetRange(config.answersSheet, 'A' + (i + 2) + ':K' + (i + 2)), [toRow(rec, count)]);
      return;
    }
  }
  await valuesAppend(sheetRange(config.answersSheet, 'A1'), [toRow(rec, 1)]);
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
