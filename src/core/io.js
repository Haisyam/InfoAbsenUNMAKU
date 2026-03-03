import fs from 'node:fs';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export function loadConfig(configPath) {
  const config = readJson(configPath, []);
  if (!Array.isArray(config) || config.length === 0) {
    throw new Error(`config kosong. Isi dulu ${configPath}`);
  }
  return config;
}

export function initialState() {
  return {
    courses: {},
    notified: {},
    notifiedChannels: {},
    lastRunAt: null,
    telegramOffset: 0,
    whatsappConnected: false,
  };
}
