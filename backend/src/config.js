// Конфигурация из env. Без service account API работает в демо-режиме:
// пароли «хинкали»/«сациви», ответы пишутся только в локальный журнал.
import fs from 'node:fs';

function readServiceAccount() {
  const b64 = process.env.GOOGLE_SA_JSON_BASE64;
  const path = process.env.GOOGLE_SA_JSON_PATH;
  try {
    if (b64) return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (path) return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    console.error('[config] не удалось прочитать service account:', e.message);
  }
  return null;
}

export const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  dataDir: process.env.DATA_DIR || '/data',
  spreadsheetId: process.env.SPREADSHEET_ID || '13UFjGy42iBV9rhGtWehsmoCnbq1rJSWOBPR_mCXTX0U',
  // единственная вкладка-источник: A Секретное слово | B Гость 1 | C Гость 2 —
  // список приглашённых (ведётся руками), туда же бэкенд дописывает ответы
  answersSheet: process.env.ANSWERS_SHEET || 'Ответы на rsvp',
  guestsTtlMs: 60 * 1000,
  serviceAccount: readServiceAccount(),
};

export const demoMode = !config.serviceAccount;
if (demoMode) {
  console.warn('[config] GOOGLE_SA_JSON_BASE64/GOOGLE_SA_JSON_PATH не заданы — демо-режим (без Google Sheets)');
}
