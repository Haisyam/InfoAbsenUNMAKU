import { appConfig } from "./core/config.js";
import {
  buildRecapMessage,
  diffSnapshot,
  fetchCourseSnapshot,
  formatNotificationMessage,
  isWithinScheduleWindow,
  refreshAllSnapshots,
  selectLatestEvent,
  shouldNotifyEvent,
} from "./core/attendance.js";
import {
  initialState,
  loadConfig,
  nowIso,
  readJson,
  writeJson,
} from "./core/io.js";
import { createTelegramService } from "./channels/telegram.js";
import { createWhatsappService } from "./channels/whatsapp.js";
import { connectMongoDB } from "./db/mongodb.js";
import { seedInitialTargets, getTargetJids } from "./db/whatsappTargets.js";

const cfg = appConfig;

function persistState(state) {
  writeJson(cfg.STATE_PATH, state);
}

// ─── Telegram ───────────────────────────────────────────────────

const telegram = createTelegramService({
  config: cfg,
  nowIso,
  writeState: persistState,
  sendRekap: handleRekapRequest,
});

// ─── WhatsApp (inisialisasi setelah semua fungsi tersedia) ───────

const whatsapp = createWhatsappService({
  config: cfg,
  nowIso,
  writeState: persistState,
  sendRekap: handleRekapRequest,
  sendDemo: sendDemoNotification,
});

// ─── Handlers ───────────────────────────────────────────────────

async function handleRekapRequest({
  channel,
  target,
  replyJid,
  state,
  replyMarkup = null,
}) {
  const config = loadConfig(cfg.CONFIG_PATH);
  
  // Ambil data targets/NIM pengguna HP dari DB sebelum merefresh
  const targets = await getTargetJids();
  await refreshAllSnapshots(config, state, nowIso, targets);

  let targetNims = null;
  if (channel === "whatsapp") {
    // Cari mapping array obyek yang .jid nya sama persis string target pemanggil `rekap`
    const matchedTargets = targets.filter((t) => t.jid === target && t.nim);
    if (matchedTargets.length > 0) {
      targetNims = matchedTargets.map((t) => t.nim);
    } else {
      // Periksa apakah dia admin utama (fallback ke global rekap tdk dibatasi)
      const senderIsAdmin = target.split("@")[0] === cfg.WHATSAPP_ADMIN_NUMBER;
      if (!senderIsAdmin) {
        // Jika bukan admin dan tidak terkait NIM manapun -> abort
        await whatsapp.sendMessage({
          jid: replyJid || target,
          text: "⚠️ OOT: Nomor Anda tidak terpaut dengan Data Mahasiswa manapun.\nMinta admin untuk mendaftarkan NIM Anda terlebih dahulu.",
        });
        return;
      }
    }
  }

  const recapText = buildRecapMessage(config, state, targetNims);
  if (channel === "telegram") {
    await telegram.sendMessage({
      chatId: target,
      text: recapText,
      replyMarkup,
    });
  }
  if (channel === "whatsapp") {
    const finalReplyJid = replyJid || target;
    await whatsapp.sendMessage({ jid: finalReplyJid, text: recapText });
  }

  persistState(state);
}

/**
 * Buat pesan demo absensi dengan format yang sama persis seperti notifikasi asli.
 */
function buildDemoMessage() {
  const demoEvent = {
    type: "new",
    meeting: 3,
    oldStatus: null,
    newStatus: "Alfa",
    critical: true,
    course: "Cloud Computing C",
    url: "https://simakng.unma.ac.id/publik/absensi/99891",
  };
  const demoStudent = {
    nim: "2414101091",
    name: "Muhamad Haisyam Khairizmi",
  };
  const msg = formatNotificationMessage(demoEvent, demoStudent);
  return `[DEMO] ${msg}`;
}

/**
 * Kirim notifikasi demo ke semua channel aktif (Telegram + WA targets dari DB).
 */
async function sendDemoNotification() {
  const text = buildDemoMessage();
  const results = { telegram: false, whatsapp: false, errors: [] };

  // Kirim ke Telegram
  const sendTelegramFlag =
    cfg.NOTIFIER_CHANNEL === "telegram" || cfg.NOTIFIER_CHANNEL === "both";
  if (sendTelegramFlag) {
    try {
      await telegram.sendMessage({ text });
      results.telegram = true;
    } catch (err) {
      results.errors.push(`Telegram: ${err.message}`);
    }
  }

  // Kirim ke semua WA targets dari DB
  const sendWhatsappFlag =
    (cfg.NOTIFIER_CHANNEL === "whatsapp" || cfg.NOTIFIER_CHANNEL === "both") &&
    cfg.WHATSAPP_ENABLE;
  if (sendWhatsappFlag) {
    try {
      const targets = await getTargetJids();
      for (const target of targets) {
        await whatsapp.sendMessage({ text, jid: target.jid });
      }
      results.whatsapp = true;
    } catch (err) {
      results.errors.push(`WhatsApp: ${err.message}`);
    }
  }

  if (results.errors.length > 0) {
    throw new Error(results.errors.join("; "));
  }
  return results;
}

async function sendNotificationMessage(text, studentNim) {
  const sendTelegram =
    cfg.NOTIFIER_CHANNEL === "telegram" || cfg.NOTIFIER_CHANNEL === "both";
  const sendWhatsapp =
    cfg.NOTIFIER_CHANNEL === "whatsapp" || cfg.NOTIFIER_CHANNEL === "both";

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
      const targets = await getTargetJids();
      for (const target of targets) {
        // Hanya kirim jika NIM target cocok dengan NIM mahasiswa (atau jika target blm punya NIM)
        if (!target.nim || target.nim === studentNim) {
          await whatsapp.sendMessage({ text, jid: target.jid });
        }
      }
      result.whatsappOk = true;
    } catch (error) {
      console.error(`[${nowIso()}] kirim WhatsApp gagal: ${error.message}`);
    }
  }

  return result;
}

async function processCourse(course, state, targets = []) {
  const key = course.id || course.name;
  const scheduleState = isWithinScheduleWindow(course, cfg.DEFAULT_TIMEZONE);
  if (!scheduleState.active) {
    console.log(`[${nowIso()}] ${course.name}: skip (di luar jadwal absensi)`);
    return;
  }

  const previous = state.courses[key] || null;
  const snapshot = await fetchCourseSnapshot(course, nowIso, targets);
  const events = diffSnapshot(
    previous || { statusesByMeeting: {} },
    snapshot,
    course,
  );
  const candidateEvents = events.filter((e) =>
    shouldNotifyEvent(e, cfg.NOTIFY_MODE),
  );
  const latestEvent = selectLatestEvent(candidateEvents);

  if (latestEvent) {
    // Karena event kini membawa .student, dedupe berdasarkan NIM mahasiswa
    const dedupeKey = `${key}:${latestEvent.student.nim}:${latestEvent.meeting}:${latestEvent.newStatus}`;
    const channelTelegramKey = `${dedupeKey}:telegram`;
    const channelWhatsappKey = `${dedupeKey}:whatsapp`;

    const alreadyDoneTelegram = Boolean(
      state.notifiedChannels?.[channelTelegramKey],
    );
    const alreadyDoneWhatsapp = Boolean(
      state.notifiedChannels?.[channelWhatsappKey],
    );

    if (
      !state.notified[dedupeKey] ||
      !alreadyDoneTelegram ||
      !alreadyDoneWhatsapp
    ) {
      // Mengirim payload ke formatter
      const message = formatNotificationMessage(
        latestEvent,
        latestEvent.student,
      );
      const sendResult = await sendNotificationMessage(
        message,
        latestEvent.student.nim,
      );

      if (sendResult.sendTelegram && sendResult.telegramOk) {
        state.notifiedChannels[channelTelegramKey] = nowIso();
      }
      if (sendResult.sendWhatsapp && sendResult.whatsappOk) {
        state.notifiedChannels[channelWhatsappKey] = nowIso();
      }

      const requiredTelegramDone =
        !sendResult.sendTelegram ||
        Boolean(state.notifiedChannels[channelTelegramKey]);
      const requiredWhatsappDone =
        !sendResult.sendWhatsapp ||
        Boolean(state.notifiedChannels[channelWhatsappKey]);
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

  const targets = await getTargetJids();

  for (const course of config) {
    try {
      await processCourse(course, state, targets);
    } catch (error) {
      console.error(`[${nowIso()}] ${course.name}: ${error.message}`);
    }
  }

  persistState(state);
}

async function main() {
  // Hubungkan ke MongoDB dan seed data awal
  if (cfg.MONGODB_URI) {
    await connectMongoDB();
    await seedInitialTargets();
  } else {
    console.warn(
      `[${nowIso()}] MONGODB_URI tidak di-set. Fitur manajemen target WA dari DB dinonaktifkan.`,
    );
  }

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

  setInterval(
    async () => {
      if (monitorBusy) return;
      monitorBusy = true;
      try {
        await runOnce(state);
      } finally {
        monitorBusy = false;
      }
    },
    cfg.INTERVAL_MINUTES * 60 * 1000,
  );

  setInterval(
    async () => {
      if (botBusy) return;
      botBusy = true;
      try {
        await telegram.pollUpdates(state);
      } finally {
        botBusy = false;
      }
    },
    Math.max(1, cfg.TELEGRAM_POLL_SECONDS) * 1000,
  );
}

main().catch((error) => {
  console.error(`[${nowIso()}] fatal:`, error);
  process.exitCode = 1;
});
