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

// Столбцы фото стоят рядом со «своим» гостем: A слово | B Гость 1 | C Фото 1 |
// D Гость 2 | E Фото 2 | F Приедут? … L Обновлено
const ANSWER_HEADERS = [
  'Секретное слово', 'Гость 1', 'Фото Гость 1', 'Гость 2', 'Фото Гость 2',
  'Приедут?', 'Трансфер', 'Мест для попутчиков', 'Ночёвка', 'Оплата домика',
  'Заполнено?', 'Обновлено',
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
await valUpdate(sheetRange(ANSWERS, 'A1:L1'), [ANSWER_HEADERS]);
await valClear(sheetRange(ANSWERS, 'M1:Z1'));

// --- 2. валидации колонок ответов (открытые вниз диапазоны — покрывают будущие строки) ---
const dvRange = (c0, c1) => ({ sheetId: answersId, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 });
const oneOf = (vals) => ({
  condition: { type: 'ONE_OF_LIST', values: vals.map((v) => ({ userEnteredValue: v })) },
  strict: true, showCustomUi: true,
});

await batch([
  { setDataValidation: { range: dvRange(5, 6), rule: oneOf(['Нет', 'Да, Гость 1', 'Да, Гость 2', 'Да, оба']) } }, // F Приедут?
  { setDataValidation: { range: dvRange(6, 7), rule: oneOf(['Нужен', 'Не нужен']) } },                             // G Трансфер
  { setDataValidation: { range: dvRange(7, 8), rule: {                                                              // H Мест
    condition: { type: 'NUMBER_BETWEEN', values: [{ userEnteredValue: '0' }, { userEnteredValue: '7' }] },
    strict: false, showCustomUi: false } } },
  { setDataValidation: { range: dvRange(8, 9), rule: oneOf(['Остаюсь', 'Не остаюсь']) } },                          // I Ночёвка
  { setDataValidation: { range: dvRange(9, 10), rule: oneOf(['Заплачу', 'Не заплачу']) } },                         // J Оплата домика
  { setDataValidation: { range: dvRange(10, 11), rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true } } },  // K Заполнено? (чекбокс)
  { repeatCell: {
    range: { sheetId: answersId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 },
    cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
  // фото-колонки C и E шире (~120px) и строки данных повыше (~90px), чтобы миниатюры
  // =IMAGE было видно; строку заголовка (индекс 0) не трогаем
  { updateDimensionProperties: {
    range: { sheetId: answersId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
    properties: { pixelSize: 120 }, fields: 'pixelSize' } },
  { updateDimensionProperties: {
    range: { sheetId: answersId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 },
    properties: { pixelSize: 120 }, fields: 'pixelSize' } },
  { updateDimensionProperties: {
    range: { sheetId: answersId, dimension: 'ROWS', startIndex: 1, endIndex: 1000 },
    properties: { pixelSize: 90 }, fields: 'pixelSize' } },
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
    const rec = [gr[0] || '', gr[1] || '', gr[2] || ''];            // [слово, имя1, имя2]
    if (idxByWord[n] != null) {
      const row = 2 + idxByWord[n];
      // имена: Гость 1 → B, Гость 2 → D (между ними столбец фото C — его не трогаем)
      await valUpdate(sheetRange(ANSWERS, 'B' + row), [[rec[1]]]);
      if (rec[2]) await valUpdate(sheetRange(ANSWERS, 'D' + row), [[rec[2]]]);
    } else {
      appends.push([rec[0], rec[1], '', rec[2], '']);              // A слово | B имя1 | C фото | D имя2 | E фото
    }
  }
  if (appends.length) await valAppend(sheetRange(ANSWERS, 'A1'), appends);
  await batch([{ deleteSheet: { sheetId: guestsId } }]);
  console.log('«Гости» перенесены в «Ответы» (' + guestRows.length + ' строк) и вкладка удалена');
}

// --- 4. «Сводка»: всё подтягивается из «Ответов» формулами (без хинкали и без «Гости») ---
// Все счётчики — в людях, не в строках: вес строки = сколько в ней гостей
// (имена в B/D, 1 или 2). Маркер приглашённости — имена, а не секретное слово:
// слово может быть ещё не вписано, а гость уже в списке. «Приедут»-счётчики
// берут людей из ответа F («Да, оба» = 2) — там пара могла ответить за одного.
const A = "'" + ANSWERS + "'!";
const rowGuests = `((${A}B2:B1000<>"")+(${A}D2:D1000<>""))`;
const guestsWhere = (cond) => `SUMPRODUCT((${cond})*${rowGuests})`;
const peopleWhere = (cond) =>
  `SUMPRODUCT((${cond})*((${A}F2:F1000="Да, Гость 1")+(${A}F2:F1000="Да, Гость 2")+2*(${A}F2:F1000="Да, оба")))`;

const svodka = [
  ['Сводка по RSVP', ''],
  ['Приглашено (человек)', `=SUMPRODUCT(${rowGuests})`],
  ['Заполнили анкету (человек)', `=${guestsWhere(`${A}K2:K1000=TRUE`)}`],
  ['Ещё не ответили (человек)', `=${guestsWhere(`${A}F2:F1000=""`)}`],
  ['Приедут (человек)', `=${peopleWhere('1')}`],
  ['Ответили «приедем» (человек)', `=${guestsWhere(`LEFT(${A}F2:F1000,2)="Да"`)}`],
  ['Ответили «не приедем» (человек)', `=${guestsWhere(`${A}F2:F1000="Нет"`)}`],
  ['Нужен трансфер (человек)', `=${peopleWhere(`${A}G2:G1000="Нужен"`)}`],
  ['Едут сами (человек)', `=${peopleWhere(`${A}G2:G1000="Не нужен"`)}`],
  ['Свободных мест у попутчиков', `=SUM(${A}H2:H1000)`],
  ['Останутся ночевать (человек)', `=${peopleWhere(`${A}I2:I1000="Остаюсь"`)}`],
  ['Оплатят домик сами (человек)', `=${peopleWhere(`${A}J2:J1000="Заплачу"`)}`],
  ['Домик за счёт молодожёнов (человек)', `=${peopleWhere(`${A}J2:J1000="Не заплачу"`)}`],
];
await valUpdate(sheetRange(SVODKA, 'A1:B' + svodka.length), svodka, 'USER_ENTERED');
await valClear(sheetRange(SVODKA, 'A' + (svodka.length + 1) + ':B60'));

console.log('готово: «' + ANSWERS + '» — единственный источник, «Сводка» пересобрана (' + svodka.length + ' строк)');
