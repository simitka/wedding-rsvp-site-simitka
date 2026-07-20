// Хранение и конвертация фото гостей. Любой присланный формат (JPEG, PNG, WebP,
// HEIC с айфонов, TIFF…) прогоняется через libvips (vipsthumbnail из пакета
// vips-tools + vips-heif, ставится в backend/Dockerfile) → качественный PNG,
// даунскейл до MAX_DIM по длинной стороне, авто-разворот по EXIF. Файлы лежат в
// /data/photos (docker volume), раздаёт их server.js как /api/rsvp/photo/<file>.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const pExecFile = promisify(execFile);

const MAX_DIM = 1600;                 // длинная сторона PNG (лишнего не храним)
export const PHOTO_MAX_BYTES = 25 * 1024 * 1024; // потолок аплоада (HEIC/RAW бывают крупными)

function photosDir() {
  return path.join(config.dataDir, 'photos');
}

export function ensurePhotosDir() {
  try {
    fs.mkdirSync(photosDir(), { recursive: true });
  } catch (e) {
    console.error('[photos] не удалось создать каталог фото:', e.message);
  }
}

// стабильный ascii-слаг гостя из секретного слова (+соль): по нему находим и
// удаляем прежние файлы слота при замене, но сам URL неугадываем за счёт rand.
function guestSlug(word) {
  return crypto.createHash('sha256').update('nu-rsvp:' + String(word)).digest('hex').slice(0, 10);
}

// имя файла раздачи: только [a-f0-9-] + .png — легко валидировать в роуте отдачи
const FILE_RE = /^[a-f0-9]{10}-[01]-[a-f0-9]{24}\.png$/;

export function isValidPhotoName(name) {
  return typeof name === 'string' && FILE_RE.test(name);
}

export function photoFilePath(name) {
  if (!isValidPhotoName(name)) return null;
  return path.join(photosDir(), name);
}

export function publicPhotoUrl(name) {
  return config.publicBaseUrl + '/api/rsvp/photo/' + name;
}

// libvips: даунскейл (только вниз, `>`), авто-разворот, вывод PNG. Через execFile
// без шелла — метасимволы в аргументах безопасны. Таймаут — от decompression-бомб.
async function convertToPng(inputBuffer) {
  const stamp = crypto.randomBytes(8).toString('hex');
  const inPath = path.join(os.tmpdir(), 'nu-in-' + stamp);
  const outPath = path.join(os.tmpdir(), 'nu-out-' + stamp + '.png');
  try {
    await fs.promises.writeFile(inPath, inputBuffer);
    await pExecFile(
      'vipsthumbnail',
      [inPath, '--size', MAX_DIM + 'x' + MAX_DIM + '>', '-o', outPath + '[strip]'],
      { timeout: 25000, maxBuffer: 4 * 1024 * 1024 }
    );
    const png = await fs.promises.readFile(outPath);
    if (!png.length || !(png[0] === 0x89 && png[1] === 0x50)) throw new Error('vips-empty');
    return png;
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

// удаляем прежние файлы слота (замена → новый URL, старьё не копим)
async function removeSlotFiles(slug, guestIndex) {
  const prefix = slug + '-' + guestIndex + '-';
  let files = [];
  try { files = await fs.promises.readdir(photosDir()); } catch (e) { return; }
  await Promise.all(files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.png'))
    .map((f) => fs.promises.unlink(path.join(photosDir(), f)).catch(() => {})));
}

// Конвертирует и сохраняет фото гостя. Бросает, если vips не смог прочитать вход
// (битый/неизвестный формат) — роут отдаёт гостю дружелюбную ошибку.
export async function savePhoto(word, guestIndex, inputBuffer) {
  const png = await convertToPng(inputBuffer);
  ensurePhotosDir();
  const slug = guestSlug(word);
  await removeSlotFiles(slug, guestIndex);
  const name = slug + '-' + guestIndex + '-' + crypto.randomBytes(12).toString('hex') + '.png';
  await fs.promises.writeFile(path.join(photosDir(), name), png);
  return { name, url: publicPhotoUrl(name) };
}

// Удаляет фото слота (кнопка «убрать» / отмена загрузки после сохранения).
export async function clearPhoto(word, guestIndex) {
  await removeSlotFiles(guestSlug(word), guestIndex);
}
