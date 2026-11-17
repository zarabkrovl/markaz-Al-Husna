// Общая логика серверных функций: проверка Telegram initData, хранилище состояния
// в приватном Vercel Blob, обращения к Bot API.
import crypto from 'node:crypto';
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';

export const STATE_PATH = 'db/state.json';
export const MAX_AUDIO_BYTES = 300 * 1024 * 1024; // 300 МБ на одну запись
export const LINK_TTL_MS = 30 * 60 * 1000; // временные ссылки живут 30 минут
const INITDATA_MAX_AGE_SEC = 24 * 60 * 60;

// ---------- ответы ----------
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function handle(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Ошибка сервера' }, 500);
    }
  };
}

export async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new HttpError(400, 'Некорректный запрос');
  }
}

// ---------- конфиг ----------
export function adminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

export const isAdminId = (id) => adminIds().includes(String(id));

function botToken() {
  const t = process.env.BOT_TOKEN;
  if (!t) throw new HttpError(500, 'Не настроен BOT_TOKEN');
  return t;
}

// ---------- проверка Telegram initData ----------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData) {
  if (typeof initData !== 'string' || !initData || initData.length > 4096) {
    throw new HttpError(401, 'Откройте раздел из Telegram');
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(401, 'Неверные данные Telegram');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken()).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) {
    throw new HttpError(401, 'Неверная подпись Telegram');
  }

  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || authDate > now + 60 || now - authDate > INITDATA_MAX_AGE_SEC) {
    throw new HttpError(401, 'Сессия устарела, откройте приложение заново');
  }

  let user;
  try {
    user = JSON.parse(params.get('user') || '');
  } catch {
    user = null;
  }
  if (!user || !Number.isSafeInteger(user.id)) throw new HttpError(401, 'Нет данных пользователя');

  return {
    id: String(user.id),
    name: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 100),
    username: user.username ? String(user.username).slice(0, 64) : '',
  };
}

// ---------- состояние (один JSON в приватном Blob) ----------
// { approved: {id: {name, username, at}}, requests: {id: {name, username, at, status}},
//   episodes: [{id, title, date, pathname, size, at}] }
const emptyState = () => ({ approved: {}, requests: {}, episodes: [] });

async function readState() {
  const res = await get(STATE_PATH, { access: 'private', useCache: false });
  if (!res || res.statusCode !== 200) return { state: emptyState(), etag: null };
  const text = await new Response(res.stream).text();
  const state = { ...emptyState(), ...JSON.parse(text) };
  return { state, etag: res.blob.etag };
}

export async function loadState() {
  return (await readState()).state;
}

// Оптимистичная блокировка по ETag: читаем, меняем, пишем с ifMatch, при гонке повторяем.
export async function mutateState(fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { state, etag } = await readState();
    const result = await fn(state);
    try {
      await put(STATE_PATH, JSON.stringify(state), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: etag !== null,
        ...(etag ? { ifMatch: etag } : {}),
      });
      return result;
    } catch (e) {
      const conflict =
        e instanceof BlobPreconditionFailedError || /already exists/i.test(String(e?.message));
      if (!conflict || attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1) + Math.random() * 80));
    }
  }
}

export function hasAccess(state, userId) {
  return isAdminId(userId) || Boolean(state.approved[userId]);
}

// ---------- Telegram Bot API ----------
export async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const displayUser = (u) =>
  `${u.name || 'Без имени'}${u.username ? ' (@' + u.username + ')' : ''}`;
