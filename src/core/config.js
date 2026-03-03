import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  return String(value).toLowerCase() === 'true';
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const ROOT = process.cwd();

export const appConfig = {
  ROOT,
  CONFIG_PATH: path.join(ROOT, 'config', 'courses.json'),
  STATE_PATH: path.join(ROOT, 'state', 'state.json'),

  INTERVAL_MINUTES: Number(process.env.CHECK_INTERVAL_MINUTES || 5),
  DRY_RUN: parseBoolean(process.env.DRY_RUN, true),
  RUN_ONCE: parseBoolean(process.env.RUN_ONCE, false),

  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'Asia/Jakarta',
  NOTIFY_MODE: String(process.env.NOTIFY_MODE || 'critical').toLowerCase(),
  NOTIFIER_CHANNEL: String(process.env.NOTIFIER_CHANNEL || 'telegram').toLowerCase(),

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  TELEGRAM_ENABLE_BOT: parseBoolean(process.env.TELEGRAM_ENABLE_BOT, true),
  TELEGRAM_POLL_SECONDS: Number(process.env.TELEGRAM_POLL_SECONDS || 5),
  TELEGRAM_ALLOWED_CHAT_IDS: parseList(process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID),

  WHATSAPP_ENABLE: parseBoolean(process.env.WHATSAPP_ENABLE, false),
  WHATSAPP_TARGETS: parseList(process.env.WHATSAPP_TARGETS),
  WHATSAPP_ALLOWED_SENDERS: parseList(process.env.WHATSAPP_ALLOWED_SENDERS),
  WHATSAPP_AUTH_DIR: process.env.WHATSAPP_AUTH_DIR || path.join(ROOT, 'state', 'wa_auth'),
  WHATSAPP_COMMAND_ENABLE: parseBoolean(process.env.WHATSAPP_COMMAND_ENABLE, true),
};
