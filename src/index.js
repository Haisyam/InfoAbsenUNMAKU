import { appConfig } from './core/config.js';
import {
  buildRecapMessage,
  diffSnapshot,
  fetchCourseSnapshot,
  formatNotificationMessage,
  isWithinScheduleWindow,
  refreshAllSnapshots,
  selectLatestEvent,
  shouldNotifyEvent,
} from './core/attendance.js';
import { initialState, loadConfig, nowIso, readJson, writeJson } from './core/io.js';
import { createTelegramService } from './channels/telegram.js';
import { createWhatsappService } from './channels/whatsapp.js';

const cfg = appConfig;

function persistState(state) {
  writeJson(cfg.STATE_PATH, state);
}

const whatsapp = createWhatsappService({
  config: cfg,
  nowIso,
  writeState: persistState,
  sendRekap: handleRekapRequest,
});

const telegram = createTelegramService({
  config: cfg,
  nowIso,
  writeState: persistState,
  sendRekap: handleRekapRequest,
});

async function handleRekapRequest({ channel, target, state, replyMarkup = null }) {
  const config = loadConfig(cfg.CONFIG_PATH);
  await refreshAllSnapshots(config, state, nowIso);

  const recapText = buildRecapMessage(config, state);
  if (channel === 'telegram') {
    await telegram.sendMessage({ chatId: target, text: recapText, replyMarkup });
  }
  if (channel === 'whatsapp') {
    await whatsapp.sendMessage({ jid: target, text: recapText });
  }

  persistState(state);
}

async function sendNotificationMessage(text) {
  const sendTelegram = cfg.NOTIFIER_CHANNEL === 'telegram' || cfg.NOTIFIER_CHANNEL === 'both';
  const sendWhatsapp = cfg.NOTIFIER_CHANNEL === 'whatsapp' || cfg.NOTIFIER_CHANNEL === 'both';

  const result = {
    sendTelegram,
    sendWhatsapp: sendWhatsapp && cfg.WHATSAPP_ENABLE,
    telegramOk: false,
    whatsappOk: false,
  };

  if (sendTelegram) {
    try {
      await telegram.sendMessage({ text });
      result.telegramOk = true;
    } catch (error) {
      console.error(`[${nowIso()}] kirim Telegram gagal: ${error.message}`);
    }
  }

  if (result.sendWhatsapp) {
    try {
      const targets = cfg.WHATSAPP_TARGETS
        .map((v) => whatsapp.normalizeWhatsappNumber(v))
        .filter(Boolean);
      for (const jid of targets) {
        await whatsapp.sendMessage({ text, jid });
      }
      result.whatsappOk = true;
    } catch (error) {
      console.error(`[${nowIso()}] kirim WhatsApp gagal: ${error.message}`);
    }
  }

  return result;
}

async function processCourse(course, state) {
  const key = course.id || course.name;
  const scheduleState = isWithinScheduleWindow(course, cfg.DEFAULT_TIMEZONE);
  if (!scheduleState.active) {
    console.log(`[${nowIso()}] ${course.name}: skip (di luar jadwal absensi)`);
    return;
  }

  const previous = state.courses[key] || null;
  const snapshot = await fetchCourseSnapshot(course, nowIso);
  const events = diffSnapshot(previous || { statusesByMeeting: {} }, snapshot, course);
  const candidateEvents = events.filter((e) => shouldNotifyEvent(e, cfg.NOTIFY_MODE));
  const latestEvent = selectLatestEvent(candidateEvents);

  if (latestEvent) {
    const dedupeKey = `${key}:${latestEvent.meeting}:${latestEvent.newStatus}`;
    const channelTelegramKey = `${dedupeKey}:telegram`;
    const channelWhatsappKey = `${dedupeKey}:whatsapp`;

    const alreadyDoneTelegram = Boolean(state.notifiedChannels?.[channelTelegramKey]);
    const alreadyDoneWhatsapp = Boolean(state.notifiedChannels?.[channelWhatsappKey]);

    if (!state.notified[dedupeKey] || !alreadyDoneTelegram || !alreadyDoneWhatsapp) {
      const message = formatNotificationMessage(latestEvent, snapshot.student);
      const sendResult = await sendNotificationMessage(message);

      if (sendResult.sendTelegram && sendResult.telegramOk) {
        state.notifiedChannels[channelTelegramKey] = nowIso();
      }
      if (sendResult.sendWhatsapp && sendResult.whatsappOk) {
        state.notifiedChannels[channelWhatsappKey] = nowIso();
      }

      const requiredTelegramDone = !sendResult.sendTelegram || Boolean(state.notifiedChannels[channelTelegramKey]);
      const requiredWhatsappDone = !sendResult.sendWhatsapp || Boolean(state.notifiedChannels[channelWhatsappKey]);
      if (requiredTelegramDone && requiredWhatsappDone) {
        state.notified[dedupeKey] = nowIso();
      }
    }
  }

  state.courses[key] = snapshot;
  state.lastRunAt = nowIso();

  console.log(
    `[${nowIso()}] ${course.name}: pertemuan=${snapshot.maxMeeting}, event=${events.length}, kandidat_notif=${candidateEvents.length}, kirim=${latestEvent ? 1 : 0}`,
  );
}

async function runOnce(state) {
  const config = loadConfig(cfg.CONFIG_PATH);
  if (!state.notifiedChannels) state.notifiedChannels = {};

  for (const course of config) {
    try {
      await processCourse(course, state);
    } catch (error) {
      console.error(`[${nowIso()}] ${course.name}: ${error.message}`);
    }
  }

  persistState(state);
}

async function main() {
  const state = {
    ...initialState(),
    ...readJson(cfg.STATE_PATH, initialState()),
  };

  if (!cfg.RUN_ONCE && cfg.WHATSAPP_ENABLE) {
    await whatsapp.initialize(state);
  }

  console.log(
    `[${nowIso()}] monitor mulai. interval=${cfg.INTERVAL_MINUTES} menit, run_once=${cfg.RUN_ONCE}, dry_run=${cfg.DRY_RUN}, notify_mode=${cfg.NOTIFY_MODE}, telegram_bot=${cfg.TELEGRAM_ENABLE_BOT}, notifier=${cfg.NOTIFIER_CHANNEL}, whatsapp=${cfg.WHATSAPP_ENABLE}`,
  );

  await runOnce(state);
  if (cfg.RUN_ONCE) return;

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
  }, cfg.INTERVAL_MINUTES * 60 * 1000);

  setInterval(async () => {
    if (botBusy) return;
    botBusy = true;
    try {
      await telegram.pollUpdates(state);
    } finally {
      botBusy = false;
    }
  }, Math.max(1, cfg.TELEGRAM_POLL_SECONDS) * 1000);
}

main().catch((error) => {
  console.error(`[${nowIso()}] fatal:`, error);
  process.exitCode = 1;
});
