import fs from 'node:fs';
import path from 'node:path';
import { appConfig } from '../core/config.js';

const CACHE_FILE = path.join(appConfig.ROOT, 'state', 'lid_map.json');

function loadFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      return new Map(Object.entries(JSON.parse(raw)));
    }
  } catch (_) {
    // ignore corrupt file
  }
  return new Map();
}

function saveToFile(map) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
  } catch (_) {
    // ignore write errors
  }
}

// Singleton in-memory map (LID@lid → number@s.whatsapp.net)
let _lidMap = loadFromFile();

export function getLidMap() {
  return _lidMap;
}

/**
 * Simpan entri baru ke map dan persist ke file.
 * @param {string} lid - JID dalam format @lid
 * @param {string} phoneJid - JID dalam format @s.whatsapp.net
 */
export function registerLid(lid, phoneJid) {
  if (!lid || !phoneJid) return;
  if (_lidMap.get(lid) === phoneJid) return; // tidak ada perubahan
  _lidMap.set(lid, phoneJid);
  saveToFile(_lidMap);
}

/**
 * Resolve @lid ke @s.whatsapp.net. Kembalikan jid asli jika tidak ditemukan.
 * @param {string} jid
 * @returns {string}
 */
export function resolveJid(jid) {
  if (!jid?.endsWith('@lid')) return jid;
  return _lidMap.get(jid) || jid;
}
