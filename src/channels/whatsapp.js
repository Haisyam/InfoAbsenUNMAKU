import fs from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { isAdminJid, handleAdminCommand } from './whatsappAdminCommands.js';
import { getLidMap, registerLid, resolveJid } from '../db/lidCache.js';

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

/**
 * Coba resolve LID ke phone JID via socket.onWhatsApp.
 * Dipanggil sekali saat pertama kali melihat LID baru.
 */
async function tryResolveLidFromNumbers(socket, nowIso, numbersToResolve) {
  for (const num of numbersToResolve) {
    try {
      let digits = String(num).replace(/[^\d]/g, '');
      if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
      // onWhatsApp menerima nomor tanpa suffix
      const results = await socket.onWhatsApp(digits);
      if (results?.length) {
        for (const r of results) {
          if (r.lid && r.jid) {
            registerLid(r.lid, r.jid);
            console.log(`[${nowIso()}] [LID] Registered: ${r.lid} → ${r.jid}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[${nowIso()}] [LID] Gagal resolve ${num}: ${err.message}`);
    }
  }
}

export function createWhatsappService({
  config,
  nowIso,
  writeState,
  sendRekap,
  sendDemo,
}) {
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let initializing = false;
  // Set LID yang sudah dicoba resolve agar tidak query berulang
  const resolvedLids = new Set(getLidMap().keys());

  function isAllowedSender(jid) {
    if (config.WHATSAPP_ALLOWED_SENDERS.length === 0) return true;
    const resolved = resolveJid(jid);
    const senderNumber = extractWhatsappNumberFromJid(resolved);
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

      // Populate LID map dari data kontak Baileys
      function populateLidMap(contacts) {
        for (const c of contacts) {
          if (c.lid && c.id && !c.id.endsWith('@lid')) {
            registerLid(c.lid, c.id);
            resolvedLids.add(c.lid);
            console.log(`[${nowIso()}] [LID] contacts map: ${c.lid} → ${c.id}`);
          }
        }
      }
      socket.ev.on('contacts.upsert', populateLidMap);
      socket.ev.on('contacts.update', populateLidMap);

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

          // Lookup LID semua nomor penting (admin + allowed senders)
          const numbersToResolve = [
            config.WHATSAPP_ADMIN_NUMBER,
            ...config.WHATSAPP_ALLOWED_SENDERS,
          ].filter(Boolean);
          if (numbersToResolve.length > 0) {
            setTimeout(() => {
              tryResolveLidFromNumbers(socket, nowIso, numbersToResolve).catch(() => {});
            }, 2000); // delay 2 detik setelah connected agar socket siap
          }
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

        const rawJid = String(message.key.remoteJid || '');
        if (!isPrivateWhatsappJid(rawJid)) return;

        // Jika @lid belum terpetakan, coba resolve dulu via onWhatsApp (lazy)
        if (rawJid.endsWith('@lid') && !resolvedLids.has(rawJid)) {
          resolvedLids.add(rawJid); // tandai agar tidak retry terus
          const numbersToResolve = [
            config.WHATSAPP_ADMIN_NUMBER,
            ...config.WHATSAPP_ALLOWED_SENDERS,
          ].filter(Boolean);
          await tryResolveLidFromNumbers(socket, nowIso, numbersToResolve);
        }

        const jid = resolveJid(rawJid); // resolve @lid → @s.whatsapp.net jika ada
        console.log(`[${nowIso()}] [WA-DEBUG] rawJid=${rawJid} → jid=${jid}`);

        if (!isAllowedSender(jid)) {
          console.log(`[${nowIso()}] WhatsApp sender ditolak filter: jid=${jid}`);
          return;
        }

        const rawText = extractWhatsappText(message.message);
        const text = rawText.toLowerCase().trim();
        if (!text) return;

        console.log(`[${nowIso()}] WhatsApp pesan masuk: "${text}" dari ${jid}`);

        // === Command Admin ===
        const senderIsAdmin = isAdminJid(jid, config.WHATSAPP_ADMIN_NUMBER, config.WHATSAPP_ADMIN_LID);
        console.log(`[${nowIso()}] [WA-DEBUG] senderIsAdmin=${senderIsAdmin} jid=${jid}`);

        if (senderIsAdmin && (text === '/admin' || text === '/demo' || text.startsWith('/target'))) {
          try {
            // Kirim ke rawJid agar WA tau kemana harus balas (@lid atau @s.whatsapp.net)
            const replyJid = rawJid.endsWith('@lid') ? rawJid : jid;
            await handleAdminCommand({ text, rawText, jid: replyJid, sendMessage, sendDemo });
          } catch (error) {
            console.error(`[${nowIso()}] WhatsApp admin command error: ${error.message}`);
            await sendMessage({ jid: rawJid, text: `❌ Error: ${error.message}` });
          }
          return;
        }

        // === Command Biasa ===
        const isInfoCommand = ['rekap', 'menu'].includes(text);
        if (!isInfoCommand) return;

        try {
          console.log(`[${nowIso()}] WhatsApp command diterima: "${text}" dari ${jid}`);
          if (text === 'menu') {
            const menuText = senderIsAdmin
              ? 'Perintah tersedia: rekap\n\n🔐 Admin: /admin'
              : 'Perintah tersedia: rekap';
            await sendMessage({ jid: rawJid, text: menuText });
            return;
          }

          await sendMessage({ jid: rawJid, text: '⏳ Mengambil data rekap terbaru...' });
          await sendRekap({ channel: 'whatsapp', target: jid, replyJid: rawJid, state });
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
