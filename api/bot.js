// Вебхук бота: кнопки «Одобрить» / «Отклонить» под заявкой.
// Telegram шлёт сюда обновления с заголовком X-Telegram-Bot-Api-Secret-Token.
import {
  HttpError,
  displayUser,
  handle,
  isAdminId,
  json,
  mutateState,
  readBody,
  safeEqual,
  tg,
} from '../lib/core.js';

export const POST = handle(async (request) => {
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(500, 'Не настроен TG_WEBHOOK_SECRET');
  if (!safeEqual(request.headers.get('x-telegram-bot-api-secret-token') || '', secret)) {
    throw new HttpError(401, 'Unauthorized');
  }

  const update = await readBody(request);
  const cb = update.callback_query;
  if (!cb || typeof cb.data !== 'string') return json({ ok: true });

  const m = /^(ap|rj):(\d{1,15})$/.exec(cb.data);
  if (!m) return json({ ok: true });

  // кнопки работают только у администраторов
  if (!isAdminId(cb.from?.id)) {
    await tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'Нет прав',
      show_alert: true,
    }).catch(() => {});
    return json({ ok: true });
  }

  const [, kind, userId] = m;
  const approve = kind === 'ap';

  const info = await mutateState((state) => {
    const req = state.requests[userId];
    if (approve) {
      const prev = state.approved[userId];
      state.approved[userId] = {
        name: req?.name || prev?.name || '',
        username: req?.username || prev?.username || '',
        at: prev?.at || Date.now(),
      };
      delete state.requests[userId];
    } else if (req) {
      state.requests[userId] = { ...req, status: 'rejected', at: Date.now() };
    }
    return { name: req?.name || '', username: req?.username || '' };
  });

  const verdict = approve ? '✅ Одобрено' : '❌ Отклонено';
  const who = displayUser(info);
  await Promise.allSettled([
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: verdict }),
    cb.message &&
      tg('editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: `Запрос доступа к «Записи эфиров»\n\n${who}\nTelegram ID: ${userId}\n\n${verdict}`,
      }),
    // уведомление пользователю (сработает, если он уже запускал бота)
    approve &&
      tg('sendMessage', {
        chat_id: userId,
        text: 'Доступ к разделу «Записи эфиров» открыт. Откройте мини-апп заново, чтобы обновить раздел.',
      }),
  ]);

  return json({ ok: true });
});
