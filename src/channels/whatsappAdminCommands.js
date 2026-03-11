import { appConfig } from '../core/config.js';

const ADMIN_HELP_TEXT = `🤖 *CekAbsen Monitor Bot*
_Sistem Notifikasi & Pemantauan Absensi Otomatis_

---
👑 *PANEL ADMINISTRATOR*

🛠️ *Manajemen Target Notifikasi*
├ • \`/target list\` – 📄 Lihat daftar target & identitas
├ • \`/target add <nomor>,<nama>,<nim>\` – ➕ Tambah target
├ • \`/target remove <nomor>\` – 🗑️ Hapus nomor target
└ • \`/target clear\` – 🧹 Hapus semua target

🔔 *Pengujian Sistem*
└ • \`/demo\` – 🚀 Kirim notifikasi uji coba ke seluruh channel

📊 *Sistem Utama*
└ • \`rekap\` – 📈 Tampilkan rekapitulasi absensi saat ini

---
💡 _Catatan: Format nomor HP menggunakan \`628xxx\` (tanpa tanda +, 0, atau spasi)._`;


/**
 * Periksa apakah JID adalah admin.
 * Mendukung @s.whatsapp.net (by phone) maupun @lid (by LID list dari env).
 */
export function isAdminJid(jid, adminNumber, adminLids = []) {
  if (!jid) return false;

  // Cek @lid langsung dari daftar WHATSAPP_ADMIN_LID
  if (jid.endsWith('@lid')) {
    const lidNum = jid.split('@')[0];
    const normalizedLids = adminLids.map((l) => String(l).split('@')[0]);
    return normalizedLids.includes(lidNum);
  }

  // Cek @s.whatsapp.net by phone number
  if (!adminNumber) return false;
  const senderNumber = String(jid).split('@')[0].split(':')[0];
  let normalized = String(adminNumber).replace(/[^\d]/g, '');
  if (normalized.startsWith('0')) normalized = `62${normalized.slice(1)}`;
  return senderNumber === normalized;
}

/**
 * Handle semua command admin.
 * @param {object} params
 * @param {string} params.text     - teks lowercase + trim
 * @param {string} params.rawText  - teks asli (case-sensitive)
 * @param {string} params.jid      - JID pengirim (untuk reply)
 * @param {function} params.sendMessage  - kirim pesan ke jid tertentu
 * @param {function} [params.sendDemo]   - kirim demo ke semua notifier (opsional)
 * @returns {Promise<boolean>} true jika command ditangani
 */
export async function handleAdminCommand({ text, rawText, jid, sendMessage, sendDemo }) {
  // === /admin ===
  if (text === '/admin') {
    await sendMessage({ jid, text: ADMIN_HELP_TEXT });
    return true;
  }

  // === /demo ===
  if (text === '/demo') {
    await sendMessage({ jid, text: '⏳ Mengirim notifikasi demo ke semua target...' });
    try {
      if (typeof sendDemo === 'function') {
        await sendDemo();
        await sendMessage({ jid, text: '✅ Demo berhasil dikirim ke semua target (Telegram & WhatsApp).' });
      } else {
        await sendMessage({ jid, text: '⚠️ Fitur demo belum dikonfigurasi di server.' });
      }
    } catch (err) {
      await sendMessage({ jid, text: `❌ Demo gagal: ${err.message}` });
    }
    return true;
  }

  // === /target ... ===
  if (text.startsWith('/target')) {
    const { listTargets, addTarget, removeTarget, clearTargets } = await import('../db/whatsappTargets.js');
    const parts = rawText.trim().split(/\s+/);
    const subCmd = (parts[1] || '').toLowerCase();

    if (subCmd === 'list') {
      const targets = await listTargets();
      if (targets.length === 0) {
        await sendMessage({ jid, text: '📋 Daftar target kosong. Belum ada nomor yang ditambahkan.' });
      } else {
        const lines = targets.map((t, i) => `${i + 1}. *${t.name}* (${t.nim})\n   └ WA: ${t.number}`);
        await sendMessage({ jid, text: `📋 *Daftar Target Notifikasi (${targets.length})*\n\n${lines.join('\n')}` });
      }
      return true;
    }

    if (subCmd === 'add') {
      const payload = parts.slice(2).join(' '); // gabungkan argumen setelah 'add'
      const [number, name, nim] = payload.split(',').map(s => s?.trim());

      if (!number || !name || !nim) {
        await sendMessage({ jid, text: '⚠️ Format salah!\nGunakan: `/target add <nomor>,<nama>,<NIM>`\nContoh: `/target add 628123456789,Budi,123456`' });
        return true;
      }
      const senderNumber = String(jid).split('@')[0].split(':')[0];
      const result = await addTarget(number, name, nim, senderNumber);
      await sendMessage({ jid, text: result.message });
      return true;
    }

    if (subCmd === 'remove') {
      const number = parts[2] || '';
      if (!number) {
        await sendMessage({ jid, text: '⚠️ Format: `/target remove <nomor>`\nContoh: `/target remove 628123456789`' });
        return true;
      }
      const result = await removeTarget(number);
      await sendMessage({ jid, text: result.message });
      return true;
    }

    if (subCmd === 'clear') {
      const result = await clearTargets();
      await sendMessage({ jid, text: result.message });
      return true;
    }

    await sendMessage({
      jid,
      text: '⚠️ Sub-perintah tidak dikenal.\n\nGunakan:\n• `/target list`\n• `/target add <nomor>`\n• `/target remove <nomor>`\n• `/target clear`',
    });
    return true;
  }

  return false;
}
