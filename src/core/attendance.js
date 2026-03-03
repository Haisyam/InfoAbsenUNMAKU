import axios from 'axios';
import * as cheerio from 'cheerio';

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

export function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

  return {
    weekdayIndex: WEEKDAY_TO_INDEX[weekdayName] ?? null,
    minutesNow: (hour * 60) + minute,
  };
}

export function isWithinScheduleWindow(course, defaultTimezone, date = new Date()) {
  if (!course.schedule) return { active: true, reason: 'no-schedule' };

  const windows = Array.isArray(course.schedule) ? course.schedule : [course.schedule];
  for (const window of windows) {
    const dayIndex = WEEKDAY_TO_INDEX[String(window.day || '').toLowerCase()];
    const startMinutes = parseTimeToMinutes(window.start);
    const endMinutes = parseTimeToMinutes(window.end);
    const timezone = window.timezone || defaultTimezone;

    if (dayIndex == null || startMinutes == null || endMinutes == null) continue;

    const graceBefore = Number(window.graceBeforeMinutes || 0);
    const graceAfter = Number(window.graceAfterMinutes || 0);
    const { weekdayIndex, minutesNow } = getZonedClock(date, timezone);

    if (weekdayIndex == null || weekdayIndex !== dayIndex) continue;

    const startWithGrace = startMinutes - graceBefore;
    const endWithGrace = endMinutes + graceAfter;
    if (minutesNow >= startWithGrace && minutesNow <= endWithGrace) {
      return { active: true, reason: 'within-window' };
    }
  }

  return { active: false, reason: 'outside-window' };
}

export async function fetchCourseSnapshot(course, nowIso) {
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
  $(target.badgesCell).find('.badge').each((_, badge) => {
    const meeting = toNumber($(badge).text().replace(/\s+/g, ' ').trim());
    if (!meeting) return;

    const classes = ($(badge).attr('class') || '').split(/\s+/).filter(Boolean);
    const badgeClass = classes.find((c) => c.startsWith('bg-'));
    statusesByMeeting[String(meeting)] = STATUS_BY_BADGE_CLASS[badgeClass] || 'Unknown';
    return undefined;
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

export function shouldNotifyEvent(event, notifyMode) {
  if (notifyMode === 'all') return true;
  return event.critical;
}

export function selectLatestEvent(events) {
  if (!events.length) return null;
  return [...events].sort((a, b) => Number(b.meeting) - Number(a.meeting))[0];
}

export function diffSnapshot(prev = { statusesByMeeting: {} }, next, course) {
  const prevStatuses = prev.statusesByMeeting || {};
  const nextStatuses = next.statusesByMeeting || {};

  const allMeetings = new Set([...Object.keys(prevStatuses), ...Object.keys(nextStatuses)]);
  const events = [...allMeetings]
    .sort((a, b) => Number(a) - Number(b))
    .flatMap((meeting) => {
      const oldStatus = prevStatuses[meeting];
      const newStatus = nextStatuses[meeting];

      if (!oldStatus && newStatus) {
        return [{ type: 'new', meeting, oldStatus: null, newStatus, critical: isCritical(newStatus) }];
      }
      if (oldStatus && newStatus && oldStatus !== newStatus) {
        return [{ type: 'changed', meeting, oldStatus, newStatus, critical: isCritical(newStatus) }];
      }
      return [];
    });

  return events.map((e) => ({ ...e, course: course.name, url: course.url }));
}

export function formatNotificationMessage(event, student) {
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

export async function refreshAllSnapshots(config, state, nowIso) {
  for (const course of config) {
    const key = course.id || course.name;
    try {
      const snapshot = await fetchCourseSnapshot(course, nowIso);
      state.courses[key] = snapshot;
      console.log(`[${nowIso()}] ${course.name}: refresh rekap ok (pertemuan=${snapshot.maxMeeting})`);
    } catch (error) {
      console.error(`[${nowIso()}] ${course.name}: refresh rekap gagal: ${error.message}`);
    }
  }
  state.lastRunAt = nowIso();
}

function summarizeCourse(snapshot) {
  const counter = { alfa: 0, izin: 0, sakit: 0 };
  for (const status of Object.values(snapshot?.statusesByMeeting || {})) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'alfa') counter.alfa += 1;
    if (normalized === 'izin') counter.izin += 1;
    if (normalized === 'sakit') counter.sakit += 1;
  }
  return counter;
}

export function buildRecapMessage(config, state) {
  const lines = ['📊 REKAP ABSENSI (tanpa Hadir)', `⏱️ ${new Date().toLocaleString('id-ID')}`, ''];

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
