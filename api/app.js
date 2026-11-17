// Публичная часть API мини-аппа. Каждый вызов проверяет подпись Telegram initData.
//   action: "state"   — статус доступа + список записей (только если доступ есть)
//   action: "request" — запросить доступ (заявка уходит админу в бот)
//   action: "url"     — временная ссылка на аудио (только если доступ есть)
import { issueSignedToken, presignUrl } from '@vercel/blob';
import {
  LINK_TTL_MS,
  HttpError,
  adminIds,
  displayUser,
  handle,
  hasAccess,
  isAdminId,
  json,
  loadState,
  mutateState,
  readBody,
  tg,
  verifyInitData,
} from '../lib/core.js';

const REREQUEST_AFTER_REJECT_MS = 60 * 60 * 1000;

function requestStatus(state, userId) {
  const r = state.requests[userId];
  return r ? r.status : 'none';
}

function publicState(state, user) {
  const access = hasAccess(state, user.id);
  const admin = isAdminId(user.id);
  return {
    user: { id: user.id, name: user.name },
    hasAccess: access,
    isAdmin: admin,
    requestStatus: access ? 'approved' : requestStatus(state, user.id),
    episodes: access
      ? [...state.episodes]
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.at - a.at))
          .map(({ id, title, date, size }) => ({ id, title, date, size }))
      : [],
  };
}

export const POST = handle(async (request) => {
  const body = await readBody(request);
  const user = verifyInitData(body.initData);

  switch (body.action) {
    case 'state': {
      return json(publicState(await loadState(), user));
    }

    case 'request': {
      const ids = adminIds();
      if (!ids.length) throw new HttpError(500, 'Не настроен ADMIN_IDS');

      const outcome = await mutateState((state) => {
        if (hasAccess(state, user.id)) return 'has-access';
        const prev = state.requests[user.id];
        if (prev?.status === 'pending') return 'already-pending';
        if (prev?.status === 'rejected' && Date.now() - prev.at < REREQUEST_AFTER_REJECT_MS) {
          return 'cooldown';
        }
        state.requests[user.id] = {
          name: user.name,
          username: user.username,
          at: Date.now(),
          status: 'pending',
        };
        return 'created';
      });

      if (outcome === 'created') {
        const text =
          `Запрос доступа к разделу «Записи эфиров»\n\n` +
          `${displayUser(user)}\nTelegram ID: ${user.id}`;
        const results = await Promise.allSettled(
          ids.map((chat_id) =>
            tg('sendMessage', {
              chat_id,
              text,
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: 'Одобрить', callback_data: `ap:${user.id}` },
                    { text: 'Отклонить', callback_data: `rj:${user.id}` },
                  ],
                ],
              },
            }),
          ),
        );
        if (results.every((r) => r.status === 'rejected')) {
          // ни один админ не получил заявку — откатываем, чтобы можно было повторить
          await mutateState((state) => {
            delete state.requests[user.id];
          });
          console.error('request notify failed', results.map((r) => r.reason?.message));
          throw new HttpError(502, 'Не удалось отправить заявку, попробуйте позже');
        }
      }

      return json(publicState(await loadState(), user));
    }

    case 'url': {
      const state = await loadState();
      if (!hasAccess(state, user.id)) throw new HttpError(403, 'Нет доступа');
      const ep = state.episodes.find((e) => e.id === body.id);
      if (!ep) throw new HttpError(404, 'Запись не найдена');

      const validUntil = Date.now() + LINK_TTL_MS;
      const token = await issueSignedToken({
        pathname: ep.pathname,
        operations: ['get'],
        validUntil,
      });
      const { presignedUrl } = await presignUrl(token, {
        operation: 'get',
        pathname: ep.pathname,
        access: 'private',
        validUntil,
      });
      return json({ url: presignedUrl, expiresAt: validUntil });
    }

    default:
      throw new HttpError(400, 'Неизвестное действие');
  }
});
