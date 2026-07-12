// Google Sheets API без зависимостей: JWT RS256 сервис-аккаунта → access token → REST.
import crypto from 'node:crypto';
import { config } from './config.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
let token = null; // { value, expiresAt }

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.expiresAt - 60 > now) return token.value;
  const sa = config.serviceAccount;
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const input =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }));
  const sig = crypto.createSign('RSA-SHA256').update(input).sign(sa.private_key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: input + '.' + b64url(sig),
    }),
  });
  if (!res.ok) throw new Error('oauth ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  token = { value: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return token.value;
}

async function api(path, init = {}) {
  const t = await getAccessToken();
  const res = await fetch(SHEETS + '/' + config.spreadsheetId + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + t,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error('sheets ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

function enc(range) {
  return encodeURIComponent(range);
}

// A1-диапазон с квотированным именем листа: «Ответы на rsvp» содержит пробелы
export function sheetRange(title, ref) {
  return "'" + String(title).replace(/'/g, "''") + "'!" + ref;
}

export async function valuesGet(range) {
  const data = await api('/values/' + enc(range));
  return data.values || [];
}

export async function valuesUpdate(range, values) {
  return api('/values/' + enc(range) + '?valueInputOption=RAW', {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

export async function valuesAppend(range, values) {
  return api('/values/' + enc(range) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({ values }),
  });
}

export async function listSheetTitles() {
  const data = await api('?fields=sheets.properties.title');
  return (data.sheets || []).map((s) => s.properties.title);
}

export async function addSheet(title) {
  return api(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
}
