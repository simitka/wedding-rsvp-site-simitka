// Разовый сервисный скрипт: приводит Google-таблицу RSVP к текущей схеме.
// Идемпотентен — можно гонять повторно. Запуск (ключ сервис-аккаунта из Keychain,
// значение не печатать):
//
//   GOOGLE_SA_JSON_BASE64="$(security find-generic-password -s wedding-rsvp-gsa -a token -w)" \
//     node backend/scripts/setup-sheets.mjs
//
// Модель: единственная вкладка-источник — «Ответы на rsvp». Её колонки
// A Секретное слово | B Гость 1 | C Гость 2 = список приглашённых (ведётся руками),
// туда же бэкенд дописывает D..J (ответы). Отдельной вкладки «Гости» нет.
//
// Что делает:
//  1. Заголовки «Ответов» (A1:J1) + выпадающие списки/чекбокс/числовой диапазон.
//  2. Если ещё есть старая вкладка «Гости» — переносит слово+имена в «Ответы» и
//     удаляет её.
//  3. Перестраивает «Сводку» формулами поверх «Ответов» (без хинкали).
import { api, sheetRange } from '../src/sheets.js';

const enc = encodeURIComponent;
const valUpdate = (range, values, mode = 'RAW') =>
  api('/values/' + enc(range) + '?valueInputOption=' + mode, { method: 'PUT', body: JSON.stringify({ values }) });
const valAppend = (range, values) =>
  api('/values/' + enc(range) + ':append?valueInputOption=RAW&insertDataOption=OVERWRITE', { method: 'POST', body: JSON.stringify({ values }) });
const valClear = (range) => api('/values/' + enc(range) + ':clear', { method: 'POST', body: '{}' });
const valGet = async (range) => (await api('/values/' + enc(range))).values || [];
const batch = (requests) => api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
const norm = (w) => String(w == null ? '' : w).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');

const ANSWERS = 'Ответы на rsvp';
const SVODKA = 'Сводка';
const GUESTS = 'Гости';

const ANSWER_HEADERS = [
  'Секретное слово', 'Гость 1', 'Гость 2', 'Приедут?', 'Трансфер',
  'Мест для попутчиков', 'Ночёвка', 'Оплата домика', 'Заполнено?', 'Обновлено',
];

// --- метаданные вкладок (нужны sheetId для валидаций/форматирования/удаления) ---
const meta = await api('?fields=sheets.properties(sheetId,title)');
const idByTitle = {};
for (const s of meta.sheets) idByTitle[s.properties.title] = s.properties.sheetId;
const answersId = idByTitle[ANSWERS];
const svodkaId = idByTitle[SVODKA];
const guestsId = idByTitle[GUESTS]; // может отсутствовать (уже удалена)
if (answersId == null) throw new Error('нет вкладки «' + ANSWERS + '»');
if (svodkaId == null) throw new Error('нет вкладки «' + SVODKA + '»');

// --- 1. заголовки «Ответов» + чистка старого хвоста колонок ---
await valUpdate(sheetRange(ANSWERS, 'A1:J1'), [ANSWER_HEADERS]);
await valClear(sheetRange(ANSWERS, 'K1:Z1'));

// --- 2. валидации колонок ответов (открытые вниз диапазоны — покрывают будущие строки) ---
const dvRange = (c0, c1) => ({ sheetId: answersId, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 });
const oneOf = (vals) => ({
  condition: { type: 'ONE_OF_LIST', values: vals.map((v) => ({ userEnteredValue: v })) },
  strict: true, showCustomUi: true,
});

await batch([
  { setDataValidation: { range: dvRange(3, 4), rule: oneOf(['Нет', 'Да, Гость 1', 'Да, Гость 2', 'Да, оба']) } }, // D Приедут?
  { setDataValidation: { range: dvRange(4, 5), rule: oneOf(['Нужен', 'Не нужен']) } },                             // E Трансфер
  { setDataValidation: { range: dvRange(5, 6), rule: {                                                              // F Мест
    condition: { type: 'NUMBER_BETWEEN', values: [{ userEnteredValue: '0' }, { userEnteredValue: '7' }] },
    strict: false, showCustomUi: false } } },
  { setDataValidation: { range: dvRange(6, 7), rule: oneOf(['Остаюсь', 'Не остаюсь']) } },                          // G Ночёвка
  { setDataValidation: { range: dvRange(7, 8), rule: oneOf(['Заплачу', 'Не заплачу']) } },                          // H Оплата домика
  { setDataValidation: { range: dvRange(8, 9), rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true } } },    // I Заполнено? (чекбокс)
  { repeatCell: {
    range: { sheetId: answersId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 10 },
    cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
  { updateSheetProperties: { properties: { sheetId: answersId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
  { updateSheetProperties: { properties: { sheetId: svodkaId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
  { repeatCell: {
    range: { sheetId: svodkaId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 1 },
    cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
]);

// --- 3. миграция старой «Гости» → «Ответы» (слово+имена), затем удаление вкладки ---
if (guestsId != null) {
  const guestRows = await valGet(sheetRange(GUESTS, 'A2:C1000'));   // [[слово, имя1, имя2], …]
  const ansWords = await valGet(sheetRange(ANSWERS, 'A2:A1000'));   // существующие слова в «Ответах»
  const idxByWord = {};
  ansWords.forEach((r, i) => { const n = norm(r[0]); if (n) idxByWord[n] = i; }); // i — смещение от строки 2
  const appends = [];
  for (const gr of guestRows) {
    const n = norm(gr[0]);
    if (!n) continue;
    const rec = [gr[0] || '', gr[1] || '', gr[2] || ''];            // A/B/C
    if (idxByWord[n] != null) {
      const row = 2 + idxByWord[n];
      await valUpdate(sheetRange(ANSWERS, 'B' + row + ':C' + row), [[rec[1], rec[2]]]); // имена, не трогая ответы
    } else {
      appends.push(rec);
    }
  }
  if (appends.length) await valAppend(sheetRange(ANSWERS, 'A1'), appends);
  await batch([{ deleteSheet: { sheetId: guestsId } }]);
  console.log('«Гости» перенесены в «Ответы» (' + guestRows.length + ' строк) и вкладка удалена');
}

// --- 4. «Сводка»: всё подтягивается из «Ответов» формулами (без хинкали и без «Гости») ---
const A = "'" + ANSWERS + "'!";
const people = `SUMPRODUCT((${A}D2:D1000="Да, Гость 1")+(${A}D2:D1000="Да, Гость 2")+2*(${A}D2:D1000="Да, оба"))`;
const peopleWhere = (cond) =>
  `SUMPRODUCT((${cond})*((${A}D2:D1000="Да, Гость 1")+(${A}D2:D1000="Да, Гость 2")+2*(${A}D2:D1000="Да, оба")))`;

const svodka = [
  ['Сводка по RSVP', ''],
  ['Приглашено (строк)', `=COUNTA(${A}A2:A1000)`],
  ['Заполнили анкету (✓)', `=COUNTIF(${A}I2:I1000, TRUE)`],
  ['Ещё не ответили', `=SUMPRODUCT((${A}A2:A1000<>"")*(${A}D2:D1000=""))`],
  ['Приедут (человек)', `=${people}`],
  ['Ответили «приедем» (заявок)', `=COUNTIF(${A}D2:D1000,"Да*")`],
  ['Ответили «не приедем»', `=COUNTIF(${A}D2:D1000,"Нет")`],
  ['Нужен трансфер (человек)', `=${peopleWhere(`${A}E2:E1000="Нужен"`)}`],
  ['Едут сами (заявок)', `=COUNTIF(${A}E2:E1000,"Не нужен")`],
  ['Свободных мест у попутчиков', `=SUM(${A}F2:F1000)`],
  ['Останутся ночевать (человек)', `=${peopleWhere(`${A}G2:G1000="Остаюсь"`)}`],
  ['Оплатят домик сами (заявок)', `=COUNTIF(${A}H2:H1000,"Заплачу")`],
  ['Домик за счёт молодожёнов (заявок)', `=COUNTIF(${A}H2:H1000,"Не заплачу")`],
];
await valUpdate(sheetRange(SVODKA, 'A1:B' + svodka.length), svodka, 'USER_ENTERED');
await valClear(sheetRange(SVODKA, 'A' + (svodka.length + 1) + ':B60'));

console.log('готово: «' + ANSWERS + '» — единственный источник, «Сводка» пересобрана (' + svodka.length + ' строк)');
