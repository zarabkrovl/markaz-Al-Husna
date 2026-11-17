// Админ-API. Доступ только у Telegram ID из ADMIN_IDS (проверка initData на сервере).
//   list            — одобренные, заявки, записи
//   grant / revoke  — выдать / забрать доступ по Telegram ID
//   upload-url      — временная ссылка для прямой загрузки MP3 в приватный Blob
//   add-episode     — зарегистрировать загруженный файл (название + дата)
//   delete-episode  — удалить запись и файл
import { issueSignedToken, presignUrl, head, del } from '@vercel/blob';
import {
  MAX_AUDIO_BYTES,
  HttpError,
  handle,
  isAdminId,
  json,
  loadState,
  mutateState,
  readBody,
  verifyInitData,
} from '../lib/core.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UPLOAD_TTL_MS = 60 * 60 * 1000;

function cleanTitle(v) {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!t || t.length > 140) throw new HttpError(400, 'Название: от 1 до 140 символов');
  return t;
}

function cleanDate(v) {
  const d = String(v ?? '');
  if (!DATE.test(d) || Number.isNaN(Date.parse(d))) throw new HttpError(400, 'Неверная дата');
  return d;
}

function cleanUserId(v) {
  const id = String(v ?? '').trim();
  if (!/^\d{1,15}$/.test(id)) throw new HttpError(400, 'Telegram ID — это число');
  return id;
}

function adminView(state) {
  return {
    approved: Object.entries(state.approved)
      .map(([id, u]) => ({ id, name: u.name || '', username: u.username || '', at: u.at || 0 }))
      .sort((a, b) => b.at - a.at),
    pending: Object.entries(state.requests)
      .filter(([, r]) => r.status === 'pending')
      .map(([id, r]) => ({ id, name: r.name || '', username: r.username || '', at: r.at })),
    episodes: [...state.episodes]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.at - a.at))
      .map(({ id, title, date, size }) => ({ id, title, date, size })),
  };
}

export const POST = handle(async (request) => {
  const body = await readBody(request);
  const user = verifyInitData(body.initData);
  if (!isAdminId(user.id)) throw new HttpError(403, 'Только для администратора');

  switch (body.action) {
    case 'list':
      return json(adminView(await loadState()));

    case 'grant': {
      const id = cleanUserId(body.userId);
      await mutateState((state) => {
        const req = state.requests[id];
        state.approved[id] = {
          name: req?.name || '',
          username: req?.username || '',
          at: Date.now(),
        };
        delete state.requests[id];
      });
      return json(adminView(await loadState()));
    }

    case 'revoke': {
      const id = cleanUserId(body.userId);
      await mutateState((state) => {
        delete state.approved[id];
        delete state.requests[id];
      });
      return json(adminView(await loadState()));
    }

    case 'upload-url': {
      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_AUDIO_BYTES) {
        throw new HttpError(400, `Файл слишком большой (максимум ${MAX_AUDIO_BYTES / 1024 / 1024} МБ)`);
      }
      const id = crypto.randomUUID();
      const pathname = `episodes/${id}.mp3`;
      const validUntil = Date.now() + UPLOAD_TTL_MS;
      const opts = {
        allowedContentTypes: ['audio/mpeg'],
        maximumSizeInBytes: MAX_AUDIO_BYTES,
      };
      const token = await issueSignedToken({
        pathname,
        operations: ['put'],
        validUntil,
        ...opts,
      });
      const { presignedUrl } = await presignUrl(token, {
        operation: 'put',
        pathname,
        access: 'private',
        validUntil,
        addRandomSuffix: false,
        allowOverwrite: false,
        ...opts,
      });
      return json({ id, uploadUrl: presignedUrl });
    }

    case 'add-episode': {
      if (!UUID.test(String(body.id))) throw new HttpError(400, 'Неверный id');
      const title = cleanTitle(body.title);
      const date = cleanDate(body.date);
      const pathname = `episodes/${body.id}.mp3`;
      let size;
      try {
        size = (await head(pathname)).size;
      } catch {
        throw new HttpError(400, 'Файл не найден — загрузка не завершилась');
      }
      await mutateState((state) => {
        if (state.episodes.some((e) => e.id === body.id)) return;
        state.episodes.push({ id: body.id, title, date, pathname, size, at: Date.now() });
      });
      return json(adminView(await loadState()));
    }

    case 'delete-episode': {
      if (!UUID.test(String(body.id))) throw new HttpError(400, 'Неверный id');
      const pathname = await mutateState((state) => {
        const ep = state.episodes.find((e) => e.id === body.id);
        if (!ep) return null;
        state.episodes = state.episodes.filter((e) => e.id !== body.id);
        return ep.pathname;
      });
      if (pathname) await del(pathname);
      return json(adminView(await loadState()));
    }

    default:
      throw new HttpError(400, 'Неизвестное действие');
  }
});
