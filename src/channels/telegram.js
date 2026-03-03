import axios from 'axios';

const CALLBACK_REKAP = 'rekap_absensi';

export function createTelegramService({
  config,
  nowIso,
  writeState,
  sendRekap,
}) {
  function isAllowedChat(chatId) {
    if (config.TELEGRAM_ALLOWED_CHAT_IDS.length === 0) return true;
    return config.TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId));
  }

  function menuKeyboard() {
    return {
      inline_keyboard: [[{ text: 'Rekap Absensi', callback_data: CALLBACK_REKAP }]],
    };
  }

  async function telegramApi(method, payload) {
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;
    const response = await axios.post(url, payload, { timeout: 30_000 });
    return response.data;
  }

  async function sendMessage({ text, chatId = config.TELEGRAM_CHAT_ID, replyMarkup = null }) {
    if (config.DRY_RUN) {
      console.log(`\n[DRY_RUN TELEGRAM][chat_id=${chatId}]\n${text}\n`);
      return;
    }

    if (!config.TELEGRAM_BOT_TOKEN || !chatId) {
      throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diisi di .env');
    }

    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    await telegramApi('sendMessage', payload);
  }

  async function answerCallbackQuery(callbackQueryId, text = 'OK') {
    if (config.DRY_RUN || !config.TELEGRAM_BOT_TOKEN) return;
    await telegramApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  async function handleUpdate(update, state) {
    if (update.message) {
      const text = String(update.message.text || '').trim();
      const chatId = String(update.message.chat?.id || '');
      if (!chatId) return;

      if (!isAllowedChat(chatId)) {
        await sendMessage({ chatId, text: 'Chat ini tidak diizinkan untuk bot absensi.' });
        return;
      }

      if (text === '/start') {
        await sendMessage({
          chatId,
          text: '🤖 Bot monitor absensi aktif.\nGunakan /info atau tombol di bawah untuk lihat rekap.',
          replyMarkup: menuKeyboard(),
        });
        return;
      }

      if (text === '/info' || text === '/rekap') {
        await sendMessage({ chatId, text: '⏳ Mengambil data rekap terbaru...' });
        await sendRekap({ channel: 'telegram', target: chatId, replyMarkup: menuKeyboard(), state });
      }
      return;
    }

    if (update.callback_query) {
      const query = update.callback_query;
      const data = String(query.data || '');
      const chatId = String(query.message?.chat?.id || '');

      if (query.id) await answerCallbackQuery(query.id, 'Sedang memproses rekap...');
      if (!chatId || !isAllowedChat(chatId)) return;

      if (data === CALLBACK_REKAP) {
        await sendMessage({ chatId, text: '⏳ Mengambil data rekap terbaru...' });
        await sendRekap({ channel: 'telegram', target: chatId, replyMarkup: menuKeyboard(), state });
      }
    }
  }

  async function pollUpdates(state) {
    if (!config.TELEGRAM_ENABLE_BOT || !config.TELEGRAM_BOT_TOKEN) return;

    try {
      const offset = Number(state.telegramOffset || 0) + 1;
      const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates`;
      const response = await axios.post(url, {
        offset,
        timeout: 20,
        allowed_updates: ['message', 'callback_query'],
      }, { timeout: 30_000 });

      const updates = response.data?.result || [];
      for (const update of updates) {
        await handleUpdate(update, state);
        state.telegramOffset = update.update_id;
      }

      if (updates.length > 0) {
        writeState(state);
      }
    } catch (error) {
      const status = error?.response?.status;
      if (status === 409) {
        console.error(`[${nowIso()}] polling telegram conflict (409): ada instance bot lain yang juga menjalankan getUpdates.`);
        return;
      }
      console.error(`[${nowIso()}] polling telegram error: ${error.message}`);
    }
  }

  return {
    sendMessage,
    pollUpdates,
  };
}
