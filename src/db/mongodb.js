import { MongoClient } from 'mongodb';
import { appConfig } from '../core/config.js';

let client = null;
let db = null;

export async function connectMongoDB() {
  if (db) return db;

  if (!appConfig.MONGODB_URI) {
    throw new Error('MONGODB_URI tidak di-set di .env');
  }

  client = new MongoClient(appConfig.MONGODB_URI);
  await client.connect();
  db = client.db(appConfig.MONGODB_DB_NAME);
  console.log(`[MongoDB] Terhubung ke database "${appConfig.MONGODB_DB_NAME}"`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('MongoDB belum terhubung. Panggil connectMongoDB() terlebih dahulu.');
  return db;
}

export async function closeMongoDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
