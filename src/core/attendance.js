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

export async function fetchCourseSnapshot(course, nowIso, dbTargets = []) {
  const response = await axios.get(course.url, {
    timeout: 20_000,
    headers: {
      'User-Agent': 'cekabsen-monitor/1.0 (+https://simakng.unma.ac.id)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  const $ = cheerio.load(response.data);
  const rows = $('table tbody tr');

  // course.students disiapkan formatnya: [{nim, nameMatch}, ...]
  // jika masih pakai format lama (course.nim, course.nameMatch), konversi otomatis
  let targetStudents = Array.isArray(course.students) 
    ? [...course.students] 
    : [{ nim: course.nim, nameMatch: course.nameMatch }];

  // Gabungkan dbTargets jika ada (menambahkan nim target WA yang terdaftar)
  if (dbTargets && dbTargets.length > 0) {
    for (const dbt of dbTargets) {
      if (dbt.nim && !targetStudents.find(t => t.nim === dbt.nim)) {
        targetStudents.push({ nim: dbt.nim, nameMatch: dbt.name });
      }
    }
  }

  const snapshotStudents = {};
  let globalMaxMeeting = 0;

  for (const stu of targetStudents) {
    let targetCell = null;
    let foundNim = '';
    let foundName = '';

    rows.each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;

      const nim = $(cells[0]).text().trim();
      const name = $(cells[1]).text().trim();

      const nimMatch = stu.nim && nim === String(stu.nim).trim();
      const nameMatch = stu.nameMatch && normalizeName(name) === normalizeName(stu.nameMatch);
      if (nimMatch || nameMatch) {
        targetCell = cells[2];
        foundNim = nim;
        foundName = name;
        return false; // stop jQuery each
      }
      return undefined;
    });

    if (!targetCell) {
      console.warn(`⚠️ [WARNING] Mahasiswa tidak ditemukan pada ${course.name} (nim=${stu.nim || '-'}, name=${stu.nameMatch || '-'})`);
      continue;
    }

    const statusesByMeeting = {};
    $(targetCell).find('.badge').each((_, badge) => {
      const meeting = toNumber($(badge).text().replace(/\s+/g, ' ').trim());
      if (!meeting) return;

      const classes = ($(badge).attr('class') || '').split(/\s+/).filter(Boolean);
      const badgeClass = classes.find((c) => c.startsWith('bg-'));
      statusesByMeeting[String(meeting)] = STATUS_BY_BADGE_CLASS[badgeClass] || 'Unknown';
    });

    const maxMeeting = Object.keys(statusesByMeeting).reduce((acc, k) => Math.max(acc, Number(k)), 0);
    globalMaxMeeting = Math.max(globalMaxMeeting, maxMeeting);

    snapshotStudents[foundNim] = {
      nim: foundNim,
      name: foundName,
      statusesByMeeting,
      maxMeeting,
    };
  }

  if (Object.keys(snapshotStudents).length === 0) {
    throw new Error(`Tidak ada satupun mahasiswa yang ditemukan pada course ${course.name}`);
  }

  return {
    students: snapshotStudents,
    maxMeeting: globalMaxMeeting,
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

export function diffSnapshot(prev = { students: {} }, next, course) {
  const prevStudents = prev.students || {};
  const nextStudents = next.students || {};
  const allEvents = [];

  for (const [nim, nextStuInfo] of Object.entries(nextStudents)) {
    const prevStuInfo = prevStudents[nim] || { statusesByMeeting: {} };
    
    const prevStatuses = prevStuInfo.statusesByMeeting || {};
    const nextStatuses = nextStuInfo.statusesByMeeting || {};

    const allMeetings = new Set([...Object.keys(prevStatuses), ...Object.keys(nextStatuses)]);
    const stuEvents = [...allMeetings]
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

    for (const e of stuEvents) {
      allEvents.push({ ...e, course: course.name, url: course.url, student: { nim, name: nextStuInfo.name } });
    }
  }

  return allEvents;
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
    `⏱️ ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`,
  ].join('\n');
}
export async function refreshAllSnapshots(config, state, nowIso, dbTargets = []) {
  for (const course of config) {
    const key = course.id || course.name;
    try {
      const snapshot = await fetchCourseSnapshot(course, nowIso, dbTargets);
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
  for (const stuInfo of Object.values(snapshot?.students || {})) {
    for (const status of Object.values(stuInfo.statusesByMeeting || {})) {
      const normalized = String(status || '').toLowerCase();
      if (normalized === 'alfa') counter.alfa += 1;
      if (normalized === 'izin') counter.izin += 1;
      if (normalized === 'sakit') counter.sakit += 1;
    }
  }
  return counter;
}

export function buildRecapMessage(config, state, targetNims = null) {
  const lines = [];

  let studentName = null;
  let studentNim = null;

  if (targetNims && targetNims.length > 0) {
    for (const course of config) {
      const key = course.id || course.name;
      const snapshot = state.courses[key];
      if (snapshot && snapshot.students) {
        for (const stu of Object.values(snapshot.students)) {
           if (targetNims.includes(stu.nim)) {
             studentName = stu.name;
             studentNim = stu.nim;
             break;
           }
        }
      }
      if (studentName) break;
    }
  }

  lines.push('*REKAP ABSENSI*');
  if (studentName) {
    lines.push(`Nama: ${studentName}`);
    lines.push(`NPM: ${studentNim}`);
  } else {
    lines.push('(Seluruh Mahasiswa)');
  }
  lines.push(`Waktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
  lines.push('--------------------------------');

  let totalAlfa = 0;
  let totalIzin = 0;
  let totalSakit = 0;

  for (const course of config) {
    const key = course.id || course.name;
    if (course.hideFromRecap || key.includes('-demo-')) continue;

    const snapshot = state.courses[key];
    if (!snapshot) {
      if (!studentName) {
        lines.push(`* ${course.name}`);
        lines.push('  (data belum tersedia)');
        lines.push('');
      }
      continue;
    }

    const studentsToDisplay = [];
    for (const stuInfo of Object.values(snapshot.students || {})) {
      if (targetNims && targetNims.length > 0 && !targetNims.includes(stuInfo.nim)) {
        continue;
      }
      
      let stuAlfa = 0, stuIzin = 0, stuSakit = 0;
      for (const status of Object.values(stuInfo.statusesByMeeting || {})) {
         const normalized = String(status || '').toLowerCase();
         if (normalized === 'alfa') stuAlfa += 1;
         if (normalized === 'izin') stuIzin += 1;
         if (normalized === 'sakit') stuSakit += 1;
      }
      
      totalAlfa += stuAlfa;
      totalIzin += stuIzin;
      totalSakit += stuSakit;

      const hasBadStatus = stuAlfa > 0 || stuIzin > 0 || stuSakit > 0;
      if (hasBadStatus || targetNims) {
        if (studentName) {
            studentsToDisplay.push(`  Alfa: ${stuAlfa} | Izin: ${stuIzin} | Sakit: ${stuSakit}`);
        } else {
            studentsToDisplay.push(`  - ${stuInfo.name.split(' ')[0]} -> Alfa: ${stuAlfa} | Izin: ${stuIzin} | Sakit: ${stuSakit}`);
        }
      }
    }
    
    if (studentName && studentsToDisplay.length === 0) {
      continue;
    }

    lines.push(`* ${course.name}`);
    if (studentsToDisplay.length > 0) {
      lines.push(...studentsToDisplay);
    } else {
      lines.push('  (Aman - Tidak ada absen buruk)');
    }
    lines.push(`  Pertemuan: ${snapshot.maxMeeting || 0}`);
    lines.push('');
  }

  lines.push('--------------------------------');
  lines.push('*Total Akumulasi:*');
  lines.push(`Alfa: ${totalAlfa} | Izin: ${totalIzin} | Sakit: ${totalSakit}`);
  
  return lines.join('\n');
}
