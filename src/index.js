import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config', 'courses.json');
const STATE_PATH = path.join(ROOT, 'state', 'state.json');

const INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 5);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const RUN_ONCE = String(process.env.RUN_ONCE || 'false').toLowerCase() === 'true';
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Jakarta';
const NOTIFY_MODE = String(process.env.NOTIFY_MODE || 'critical').toLowerCase();
const TELEGRAM_ENABLE_BOT = String(process.env.TELEGRAM_ENABLE_BOT || 'true').toLowerCase() === 'true';
const TELEGRAM_POLL_SECONDS = Number(process.env.TELEGRAM_POLL_SECONDS || 5);
const TELEGRAM_ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || TELEGRAM_CHAT_ID)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const CALLBACK_REKAP = 'rekap_absensi';

const STATUS_BY_BADGE_CLASS = {
  'bg-success': 'Hadir',
  'bg-danger': 'Alfa',
  'bg-warning': 'Sakit',
  'bg-info': 'Izin',
};
const STATUS_EMOJI = {
  Hadir: '✅',
  Alfa: '🚨',
  Sakit: '🤒',
  Izin: '🟦',
  Unknown: '❓',
};

const CRITICAL_STATUSES = new Set(['alfa', 'belum absen', 'unknown']);
const WEEKDAY_TO_INDEX = {
  minggu: 0,
  sunday: 0,
  senin: 1,
  monday: 1,
  selasa: 2,
  tuesday: 2,
  rabu: 3,
  wednesday: 3,
  kamis: 4,
  thursday: 4,
  jumat: 5,
  "jum'at": 5,
  friday: 5,
  sabtu: 6,
  saturday: 6,
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.error(`[${nowIso()}] gagal baca JSON ${filePath}:`, error.message);
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function loadConfig() {
  const config = readJson(CONFIG_PATH, []);
  if (!Array.isArray(config) || config.length === 0) {
    throw new Error(`config kosong. Isi dulu ${CONFIG_PATH}`);
  }
  return config;
}

function initialState() {
  return {
    courses: {},
    notified: {},
    lastRunAt: null,
    telegramOffset: 0,
  };
}

function toNumber(text) {
  const n = Number(String(text || '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseTimeToMinutes(hhmm) {
  const [hh, mm] = String(hhmm || '').split(':');
  const h = Number(hh);
  const m = Number(mm);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return (h * 60) + m;
}

function getZonedClock(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase();
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  const weekdayIndex = WEEKDAY_TO_INDEX[weekdayName] ?? null;

  return {
    weekdayIndex,
    minutesNow: (hour * 60) + minute,
  };
}

function isWithinScheduleWindow(course, date = new Date()) {
  if (!course.schedule) {
    return { active: true, reason: 'no-schedule' };
  }

  const windows = Array.isArray(course.schedule) ? course.schedule : [course.schedule];
  for (const window of windows) {
    const dayIndex = WEEKDAY_TO_INDEX[String(window.day || '').toLowerCase()];
    const startMinutes = parseTimeToMinutes(window.start);
    const endMinutes = parseTimeToMinutes(window.end);
    const timezone = window.timezone || DEFAULT_TIMEZONE;

    if (dayIndex == null || startMinutes == null || endMinutes == null) {
      continue;
    }

    const graceBefore = Number(window.graceBeforeMinutes || 0);
    const graceAfter = Number(window.graceAfterMinutes || 0);
    const { weekdayIndex, minutesNow } = getZonedClock(date, timezone);

    if (weekdayIndex == null) continue;
    if (weekdayIndex !== dayIndex) continue;

    const startWithGrace = startMinutes - graceBefore;
    const endWithGrace = endMinutes + graceAfter;
    if (minutesNow >= startWithGrace && minutesNow <= endWithGrace) {
      return { active: true, reason: 'within-window' };
    }
  }

  return { active: false, reason: 'outside-window' };
}

async function fetchCourseSnapshot(course) {
  const response = await axios.get(course.url, {
    timeout: 20_000,
    headers: {
      'User-Agent': 'cekabsen-monitor/1.0 (+https://simakng.unma.ac.id)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  const $ = cheerio.load(response.data);
  const rows = $('table tbody tr');

  let target = null;

  rows.each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    const nim = $(cells[0]).text().trim();
    const name = $(cells[1]).text().trim();

    const nimMatch = course.nim && nim === String(course.nim).trim();
    const nameMatch = course.nameMatch && normalizeName(name) === normalizeName(course.nameMatch);

    if (nimMatch || nameMatch) {
      target = { nim, name, badgesCell: cells[2] };
      return false;
    }

    return undefined;
  });

  if (!target) {
    throw new Error(`Mahasiswa tidak ditemukan pada ${course.name} (nim=${course.nim || '-'}, name=${course.nameMatch || '-'})`);
  }

  const statusesByMeeting = {};
  $(target.badgesCell)
    .find('.badge')
    .each((_, badge) => {
      const badgeText = $(badge).text().replace(/\s+/g, ' ').trim();
      const meeting = toNumber(badgeText);
      if (!meeting) return;

      const classes = ($(badge).attr('class') || '').split(/\s+/).filter(Boolean);
      const badgeClass = classes.find((c) => c.startsWith('bg-'));
      const status = STATUS_BY_BADGE_CLASS[badgeClass] || 'Unknown';

      statusesByMeeting[String(meeting)] = status;
    });

  return {
    student: { nim: target.nim, name: target.name },
    statusesByMeeting,
    maxMeeting: Object.keys(statusesByMeeting).reduce((acc, k) => Math.max(acc, Number(k)), 0),
    fetchedAt: nowIso(),
  };
}

function isCritical(status) {
  return CRITICAL_STATUSES.has(String(status || '').toLowerCase());
}

function shouldNotifyEvent(event) {
  if (NOTIFY_MODE === 'all') return true;
  return event.critical;
}

function selectLatestEvent(events) {
  if (!events.length) return null;
  return [...events].sort((a, b) => Number(b.meeting) - Number(a.meeting))[0];
}

function diffSnapshot(prev = { statusesByMeeting: {} }, next, course) {
  const prevStatuses = prev.statusesByMeeting || {};
  const nextStatuses = next.statusesByMeeting || {};

  const allMeetings = new Set([...Object.keys(prevStatuses), ...Object.keys(nextStatuses)]);
  const sortedMeetings = [...allMeetings].sort((a, b) => Number(a) - Number(b));

  const events = [];

  for (const meeting of sortedMeetings) {
    const oldStatus = prevStatuses[meeting];
    const newStatus = nextStatuses[meeting];

    if (!oldStatus && newStatus) {
      events.push({
        type: 'new',
        meeting,
        oldStatus: null,
        newStatus,
        critical: isCritical(newStatus),
      });
      continue;
    }

    if (oldStatus && newStatus && oldStatus !== newStatus) {
      events.push({
        type: 'changed',
        meeting,
        oldStatus,
        newStatus,
        critical: isCritical(newStatus),
      });
    }
  }

  return events.map((e) => ({ ...e, course: course.name, url: course.url }));
}

function formatTelegramMessage(event, student) {
  const icon = event.critical ? '🚨' : '📌';
  const title = event.critical ? 'ALERT ABSENSI' : 'UPDATE ABSENSI';
  const statusEmoji = STATUS_EMOJI[event.newStatus] || '❓';
  const statusLine = `${statusEmoji} Status: ${event.newStatus}`;
  const changeLine = event.type === 'changed'
    ? `🔁 Perubahan: ${event.oldStatus} -> ${event.newStatus}`
    : '🆕 Terdeteksi pertemuan baru';

  return [
    `${icon} ${title}`,
    `📚 Matkul: ${event.course}`,
    `👤 Mahasiswa: ${student.name} (${student.nim})`,
    `🗓️ Pertemuan terbaru: ke-${event.meeting}`,
    statusLine,
    changeLine,
    `🔗 ${event.url}`,
    `⏱️ ${new Date().toLocaleString('id-ID')}`,
  ].join('\n');
}

function telegramMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Rekap Absensi', callback_data: CALLBACK_REKAP }],
    ],
  };
}

function isAllowedChat(chatId) {
  if (TELEGRAM_ALLOWED_CHAT_IDS.length === 0) return true;
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId));
}

async function telegramApi(method, payload) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await axios.post(url, payload, { timeout: 30_000 });
  return response.data;
}

async function sendTelegramMessage({ text, chatId = TELEGRAM_CHAT_ID, replyMarkup = null }) {
  if (DRY_RUN) {
    console.log(`\n[DRY_RUN TELEGRAM][chat_id=${chatId}]\n${text}\n`);
    return;
  }

  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diisi di .env');
  }

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  await telegramApi('sendMessage', payload);
}

async function refreshAllSnapshots(config, state) {
  for (const course of config) {
    const key = course.id || course.name;
    try {
      const snapshot = await fetchCourseSnapshot(course);
      state.courses[key] = snapshot;
      console.log(`[${nowIso()}] ${course.name}: refresh rekap ok (pertemuan=${snapshot.maxMeeting})`);
    } catch (error) {
      console.error(`[${nowIso()}] ${course.name}: refresh rekap gagal: ${error.message}`);
    }
  }
  state.lastRunAt = nowIso();
}

function summarizeCourse(snapshot) {
  const counter = {
    alfa: 0,
    izin: 0,
    sakit: 0,
  };

  for (const status of Object.values(snapshot?.statusesByMeeting || {})) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'alfa') counter.alfa += 1;
    if (normalized === 'izin') counter.izin += 1;
    if (normalized === 'sakit') counter.sakit += 1;
  }

  return counter;
}

function buildRecapMessage(config, state) {
  const lines = [
    '📊 REKAP ABSENSI (tanpa Hadir)',
    `⏱️ ${new Date().toLocaleString('id-ID')}`,
    '',
  ];

  let totalAlfa = 0;
  let totalIzin = 0;
  let totalSakit = 0;

  for (const course of config) {
    const key = course.id || course.name;
    const snapshot = state.courses[key];

    if (!snapshot) {
      lines.push(`• ${course.name}`);
      lines.push('  data belum tersedia');
      lines.push('');
      continue;
    }

    const stats = summarizeCourse(snapshot);
    totalAlfa += stats.alfa;
    totalIzin += stats.izin;
    totalSakit += stats.sakit;

    lines.push(`• ${course.name}`);
    lines.push(`  🚨 Alfa: ${stats.alfa} | 🟦 Izin: ${stats.izin} | 🤒 Sakit: ${stats.sakit}`);
    lines.push(`  🧾 Pertemuan tercatat: ${snapshot.maxMeeting || 0}`);
    lines.push('');
  }

  lines.push('TOTAL SEMUA MATKUL');
  lines.push(`🚨 Alfa: ${totalAlfa} | 🟦 Izin: ${totalIzin} | 🤒 Sakit: ${totalSakit}`);

  return lines.join('\n');
}

async function sendBotMenu(chatId) {
  const text = [
    '🤖 Bot monitor absensi aktif.',
    'Gunakan /info atau tombol di bawah untuk lihat rekap.',
  ].join('\n');

  await sendTelegramMessage({
    chatId,
    text,
    replyMarkup: telegramMenuKeyboard(),
  });
}

async function sendRekap(chatId, state) {
  const config = loadConfig();
  await refreshAllSnapshots(config, state);
  const recapText = buildRecapMessage(config, state);
  await sendTelegramMessage({
    chatId,
    text: recapText,
    replyMarkup: telegramMenuKeyboard(),
  });
  writeJson(STATE_PATH, state);
}

async function answerCallbackQuery(callbackQueryId, text = 'OK') {
  if (DRY_RUN) return;
  if (!TELEGRAM_BOT_TOKEN) return;

  await telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function handleTelegramUpdate(update, state) {
  if (update.message) {
    const text = String(update.message.text || '').trim();
    const chatId = String(update.message.chat?.id || '');
    if (!chatId) return;

    if (!isAllowedChat(chatId)) {
      await sendTelegramMessage({ chatId, text: 'Chat ini tidak diizinkan untuk bot absensi.' });
      return;
    }

    if (text === '/start') {
      await sendBotMenu(chatId);
      return;
    }

    if (text === '/info' || text === '/rekap') {
      await sendTelegramMessage({ chatId, text: '⏳ Mengambil data rekap terbaru...' });
      await sendRekap(chatId, state);
      return;
    }
  }

  if (update.callback_query) {
    const query = update.callback_query;
    const data = String(query.data || '');
    const chatId = String(query.message?.chat?.id || '');

    if (query.id) {
      await answerCallbackQuery(query.id, 'Sedang memproses rekap...');
    }

    if (!chatId || !isAllowedChat(chatId)) {
      return;
    }

    if (data === CALLBACK_REKAP) {
      await sendTelegramMessage({ chatId, text: '⏳ Mengambil data rekap terbaru...' });
      await sendRekap(chatId, state);
    }
  }
}

async function pollTelegramUpdates(state) {
  if (!TELEGRAM_ENABLE_BOT) return;
  if (!TELEGRAM_BOT_TOKEN) return;

  try {
    const offset = Number(state.telegramOffset || 0) + 1;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
    const response = await axios.post(url, {
      offset,
      timeout: 20,
      allowed_updates: ['message', 'callback_query'],
    }, { timeout: 30_000 });

    const updates = response.data?.result || [];
    for (const update of updates) {
      await handleTelegramUpdate(update, state);
      state.telegramOffset = update.update_id;
    }

    if (updates.length > 0) {
      writeJson(STATE_PATH, state);
    }
  } catch (error) {
    console.error(`[${nowIso()}] polling telegram error: ${error.message}`);
  }
}

async function processCourse(course, state) {
  const key = course.id || course.name;
  const scheduleState = isWithinScheduleWindow(course);
  if (!scheduleState.active) {
    console.log(`[${nowIso()}] ${course.name}: skip (di luar jadwal absensi)`);
    return;
  }

  const previous = state.courses[key] || null;

  const snapshot = await fetchCourseSnapshot(course);
  const events = diffSnapshot(previous || { statusesByMeeting: {} }, snapshot, course);
  const candidateEvents = events.filter((e) => shouldNotifyEvent(e));
  const latestEvent = selectLatestEvent(candidateEvents);

  if (latestEvent) {
    const dedupeKey = `${key}:${latestEvent.meeting}:${latestEvent.newStatus}`;
    if (!state.notified[dedupeKey]) {
      const message = formatTelegramMessage(latestEvent, snapshot.student);
      await sendTelegramMessage({ text: message });
      state.notified[dedupeKey] = nowIso();
    }
  }

  state.courses[key] = snapshot;
  state.lastRunAt = nowIso();

  console.log(
    `[${nowIso()}] ${course.name}: pertemuan=${snapshot.maxMeeting}, event=${events.length}, kandidat_notif=${candidateEvents.length}, kirim=${latestEvent ? 1 : 0}`,
  );
}

async function runOnce(state) {
  const config = loadConfig();

  for (const course of config) {
    try {
      await processCourse(course, state);
    } catch (error) {
      console.error(`[${nowIso()}] ${course.name}: ${error.message}`);
    }
  }

  writeJson(STATE_PATH, state);
}

async function main() {
  const state = {
    ...initialState(),
    ...readJson(STATE_PATH, initialState()),
  };

  console.log(
    `[${nowIso()}] monitor mulai. interval=${INTERVAL_MINUTES} menit, run_once=${RUN_ONCE}, dry_run=${DRY_RUN}, notify_mode=${NOTIFY_MODE}, bot=${TELEGRAM_ENABLE_BOT}`,
  );

  await runOnce(state);

  if (RUN_ONCE) return;

  let monitorBusy = false;
  let botBusy = false;

  setInterval(async () => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
      await runOnce(state);
    } finally {
      monitorBusy = false;
    }
  }, INTERVAL_MINUTES * 60 * 1000);

  setInterval(async () => {
    if (botBusy) return;
    botBusy = true;
    try {
      await pollTelegramUpdates(state);
    } finally {
      botBusy = false;
    }
  }, Math.max(1, TELEGRAM_POLL_SECONDS) * 1000);
}

main().catch((error) => {
  console.error(`[${nowIso()}] fatal:`, error);
  process.exitCode = 1;
});
