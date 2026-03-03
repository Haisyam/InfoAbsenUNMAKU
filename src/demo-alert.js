import process from 'node:process';
import path from 'node:path';
import axios from 'axios';
import dotenv from 'dotenv';
import makeWASocket, { Browsers, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';

dotenv.config();

const ROOT = process.cwd();
const NOTIFIER_CHANNEL = String(process.env.NOTIFIER_CHANNEL || 'telegram').toLowerCase();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const WHATSAPP_ENABLE = String(process.env.WHATSAPP_ENABLE || 'false').toLowerCase() === 'true';
const WHATSAPP_TARGETS = (process.env.WHATSAPP_TARGETS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const WHATSAPP_AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(ROOT, 'state', 'wa_auth');

function normalizeWhatsappNumber(value) {
  if (!value) return '';
  if (value.includes('@')) return value;
  let digits = String(value).replace(/[^\d]/g, '');
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function buildDemoMessage() {
  return [
    '🚨 ALERT ABSENSI (DEMO)',
    '📚 Matkul: Cloud Computing C',
    '👤 Mahasiswa: MUHAMAD HAISYAM KHAIRIZMI (2414101091)',
    '🗓️ Pertemuan: ke-3 (demo saat ini)',
    '🚨 Status: Alfa',
    '🆕 Ini pesan simulasi untuk uji notifikasi channel.',
    `⏱️ ${new Date().toLocaleString('id-ID')}`,
  ].join('\n');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID kosong');
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  }, { timeout: 20_000 });
  console.log('demo -> telegram: sent');
}

async function sendWhatsapp(text) {
  if (!WHATSAPP_ENABLE) {
    throw new Error('WHATSAPP_ENABLE=false');
  }
  if (WHATSAPP_TARGETS.length === 0) {
    throw new Error('WHATSAPP_TARGETS kosong');
  }

  const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout connect WhatsApp')), 30000);
    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'open') {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const targets = WHATSAPP_TARGETS.map((v) => normalizeWhatsappNumber(v)).filter(Boolean);
  for (const jid of targets) {
    await sock.sendMessage(jid, { text });
    console.log(`demo -> whatsapp: sent to ${jid}`);
  }
}

async function main() {
  const text = buildDemoMessage();
  const sendTelegramFlag = NOTIFIER_CHANNEL === 'telegram' || NOTIFIER_CHANNEL === 'both';
  const sendWhatsappFlag = NOTIFIER_CHANNEL === 'whatsapp' || NOTIFIER_CHANNEL === 'both';

  if (sendTelegramFlag) {
    await sendTelegram(text);
  }
  if (sendWhatsappFlag) {
    await sendWhatsapp(text);
  }
}

main().catch((error) => {
  console.error('demo alert failed:', error.message);
  process.exitCode = 1;
});
