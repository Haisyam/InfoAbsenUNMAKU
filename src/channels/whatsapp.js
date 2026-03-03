import fs from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

export function normalizeWhatsappNumber(value) {
  if (!value) return '';
  if (value.includes('@')) return value;
  let digits = String(value).replace(/[^\d]/g, '');
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function extractWhatsappNumberFromJid(jid) {
  const base = String(jid || '').split('@')[0] || '';
  return base.split(':')[0] || '';
}

function extractWhatsappText(message) {
  if (!message) return '';
  if (message.ephemeralMessage?.message) return extractWhatsappText(message.ephemeralMessage.message);
  if (message.viewOnceMessageV2?.message) return extractWhatsappText(message.viewOnceMessageV2.message);
  if (message.viewOnceMessage?.message) return extractWhatsappText(message.viewOnceMessage.message);
  return (
    message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || ''
  ).trim();
}

function isPrivateWhatsappJid(jid) {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

export function createWhatsappService({
  config,
  nowIso,
  writeState,
  sendRekap,
}) {
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let initializing = false;

  function isAllowedSender(jid) {
    if (config.WHATSAPP_ALLOWED_SENDERS.length === 0) return true;
    const senderNumber = extractWhatsappNumberFromJid(jid);
    const allowedNumbers = config.WHATSAPP_ALLOWED_SENDERS
      .map((v) => extractWhatsappNumberFromJid(normalizeWhatsappNumber(v)))
      .filter(Boolean);
    return allowedNumbers.includes(senderNumber);
  }

  function isConnected() {
    return Boolean(socket);
  }

  async function sendMessage({ text, jid }) {
    if (!config.WHATSAPP_ENABLE) return;
    if (config.DRY_RUN) {
      console.log(`\n[DRY_RUN WHATSAPP][jid=${jid}]\n${text}\n`);
      return;
    }
    if (!socket || !jid) {
      throw new Error('WhatsApp belum terkoneksi atau JID kosong');
    }
    console.log(`[${nowIso()}] Kirim WhatsApp ke ${jid}`);
    await socket.sendMessage(jid, { text });
  }

  function scheduleReconnect(state, reason = 'unknown') {
    if (!config.WHATSAPP_ENABLE || reconnectTimer) return;

    const delayMs = Math.min(60_000, 2_000 * (2 ** reconnectAttempt));
    reconnectAttempt += 1;
    console.error(`[${nowIso()}] WhatsApp reconnect dijadwalkan ${Math.round(delayMs / 1000)} detik lagi (reason=${reason}).`);

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      await initialize(state);
    }, delayMs);
  }

  async function initialize(state) {
    if (!config.WHATSAPP_ENABLE || initializing) return;
    initializing = true;

    try {
      fs.mkdirSync(config.WHATSAPP_AUTH_DIR, { recursive: true });
      const { state: authState, saveCreds } = await useMultiFileAuthState(config.WHATSAPP_AUTH_DIR);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`[${nowIso()}] Baileys WA version=${version.join('.')}, isLatest=${isLatest}`);

      socket = makeWASocket({
        auth: authState,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        version,
        browser: Browsers.ubuntu('Chrome'),
      });

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
          console.log(`[${nowIso()}] WhatsApp QR diterima. Scan QR ini di WhatsApp Linked Devices:`);
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          reconnectAttempt = 0;
          state.whatsappConnected = true;
          writeState(state);
          console.log(`[${nowIso()}] WhatsApp connected`);
        }

        if (connection === 'close') {
          state.whatsappConnected = false;
          writeState(state);

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.error(`[${nowIso()}] WhatsApp disconnected (code=${statusCode || 'unknown'})`);

          if (statusCode === 405) {
            console.error(`[${nowIso()}] WhatsApp code 405: session belum valid/terautentikasi. Biasanya perlu login ulang (scan QR).`);
          }

          if (shouldReconnect) {
            scheduleReconnect(state, `close-${statusCode || 'unknown'}`);
          } else {
            console.error(`[${nowIso()}] WhatsApp session logout. Hapus folder auth lalu login ulang jika perlu.`);
          }
        }
      });

      socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!config.WHATSAPP_COMMAND_ENABLE) return;
        if (type !== 'notify' && type !== 'append') return;
        const message = messages?.[0];
        if (!message || message.key.fromMe) return;

        const jid = String(message.key.remoteJid || '');
        if (!isPrivateWhatsappJid(jid)) return;
        if (!isAllowedSender(jid)) {
          console.log(`[${nowIso()}] WhatsApp sender ditolak filter: jid=${jid}`);
          return;
        }

        const text = extractWhatsappText(message.message).toLowerCase().trim();
        if (!text) return;

        const isInfoCommand = ['/info', '/rekap', 'info', 'rekap', 'menu'].includes(text);
        if (!isInfoCommand) return;

        try {
          console.log(`[${nowIso()}] WhatsApp command diterima: "${text}" dari ${jid}`);
          if (text === 'menu') {
            await sendMessage({ jid, text: 'Perintah tersedia: info, rekap, /info, /rekap' });
            return;
          }

          await sendMessage({ jid, text: '⏳ Mengambil data rekap terbaru...' });
          await sendRekap({ channel: 'whatsapp', target: jid, state });
        } catch (error) {
          console.error(`[${nowIso()}] WhatsApp command error: ${error.message}`);
        }
      });
    } finally {
      initializing = false;
    }
  }

  return {
    initialize,
    isConnected,
    sendMessage,
    normalizeWhatsappNumber,
  };
}
