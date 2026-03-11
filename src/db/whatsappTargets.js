import { getDb } from './mongodb.js';
import { appConfig } from '../core/config.js';

const COLLECTION = 'whatsapp_targets';

/**
 * Normalisasi nomor WA ke format tanpa @s.whatsapp.net
 * Contoh: "628xxx@s.whatsapp.net" → "628xxx"
 *         "08xxx" → "628xxx"
 */
function normalizeNumber(value) {
  if (!value) return null;
  let digits = String(value).split('@')[0].replace(/[^\d]/g, '');
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  return digits || null;
}

/**
 * Seed data awal dari env WHATSAPP_TARGETS jika koleksi kosong.
 */
export async function seedInitialTargets() {
  const col = getDb().collection(COLLECTION);
  const count = await col.countDocuments();
  if (count > 0) return;

  const initialNumbers = appConfig.WHATSAPP_TARGETS.map(normalizeNumber).filter(Boolean);
  if (initialNumbers.length === 0) return;

  const docs = initialNumbers.map((number) => ({
    number,
    addedAt: new Date().toISOString(),
    addedBy: 'system',
  }));

  await col.insertMany(docs);
  console.log(`[MongoDB] Seed ${docs.length} target(s) awal dari env WHATSAPP_TARGETS`);
}

/**
 * Ambil semua nomor target aktif.
 * @returns {Promise<any[]>} array of targets
 */
export async function listTargets() {
  const col = getDb().collection(COLLECTION);
  const docs = await col.find({}, { projection: { number: 1, name: 1, nim: 1, addedAt: 1, addedBy: 1 } }).toArray();
  return docs;
}

/**
 * Tambahkan nomor ke daftar target beserta identitas spesifik.
 * @param {string} number
 * @param {string} name 
 * @param {string} nim 
 * @param {string} addedBy - nomor admin yang menambah
 * @returns {{ success: boolean, message: string }}
 */
export async function addTarget(number, name, nim, addedBy = 'admin') {
  const normalized = normalizeNumber(number);
  if (!normalized) return { success: false, message: 'Format nomor tidak valid.' };
  if (!name || !nim) return { success: false, message: 'Nama dan NIM wajib diisi.' };

  const col = getDb().collection(COLLECTION);
  const existing = await col.findOne({ number: normalized, nim: String(nim).trim() });
  
  if (existing) {
    return { success: false, message: `Nomor *${normalized}* sudah terdaftar untuk NIM *${nim}*.` };
  }

  await col.insertOne({
    number: normalized,
    name: String(name).trim(),
    nim: String(nim).trim(),
    addedAt: new Date().toISOString(),
    addedBy,
  });

  return { success: true, message: `✅ Nomor *${normalized}* berhasil ditambahkan ke target untuk mahasiswa *${name}* (${nim}).` };
}

/**
 * Hapus nomor dari daftar target.
 * @param {string} number
 * @returns {{ success: boolean, message: string }}
 */
export async function removeTarget(number) {
  const normalized = normalizeNumber(number);
  if (!normalized) return { success: false, message: 'Format nomor tidak valid.' };

  const col = getDb().collection(COLLECTION);
  const result = await col.deleteOne({ number: normalized });

  if (result.deletedCount === 0) {
    return { success: false, message: `Nomor *${normalized}* tidak ditemukan di daftar target.` };
  }
  return { success: true, message: `🗑️ Nomor *${normalized}* berhasil dihapus dari target.` };
}

/**
 * Hapus semua nomor dari daftar target.
 * @returns {{ success: boolean, message: string, count: number }}
 */
export async function clearTargets() {
  const col = getDb().collection(COLLECTION);
  const result = await col.deleteMany({});
  return {
    success: true,
    message: `🗑️ Semua target berhasil dihapus (${result.deletedCount} nomor).`,
    count: result.deletedCount,
  };
}

/**
 * Ambil semua target beserta JID dan NIM.
 * Digunakan saat mengirim notifikasi agar sesuai sasaran.
 * @returns {Promise<any[]>}
 */
export async function getTargetJids() {
  const docs = await listTargets();
  return docs.map((d) => ({
    jid: `${d.number}@s.whatsapp.net`,
    nim: d.nim || '',
    name: d.name || ''
  }));
}
