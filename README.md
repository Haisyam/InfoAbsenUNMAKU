# cekabsen-monitor

Monitor perubahan absensi SIMAK per matkul, lalu kirim notifikasi Telegram jika status pertemuan terdeteksi bermasalah (`Alfa`).
Monitoring bisa dibatasi ke jam kuliah tertentu (agar hanya aktif pada jendela waktu absen).

## 1) Install

```bash
npm install
```

## 2) Setup

```bash
cp .env.example .env
cp config/courses.example.json config/courses.json
```

Lalu edit:
- `.env` untuk `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, interval polling.
- `config/courses.json` untuk daftar matkul/link absensi.
- `NOTIFY_MODE=critical` jika hanya ingin status bermasalah, atau `NOTIFY_MODE=all` untuk semua perubahan.
- `TELEGRAM_ENABLE_BOT=true` untuk aktifkan command bot (`/start`, `/info`) dan tombol `Rekap Absensi`.
- `NOTIFIER_CHANNEL=telegram|whatsapp|both` untuk channel notifikasi.
- Jika pakai WA: aktifkan `WHATSAPP_ENABLE=true` dan isi `WHATSAPP_TARGETS`.

## 3) Jalankan

Cek sekali:

```bash
npm run check-once
```

Jalan terus (polling):

```bash
npm start
```

## Format config course

```json
[
  {
    "id": "cloud-computing-c",
    "name": "Cloud Computing C",
    "url": "https://simakng.unma.ac.id/publik/absensi/99891",
    "nim": "2414101091",
    "nameMatch": "Muhamad Haisyam Khairizmi",
    "schedule": {
      "day": "Selasa",
      "start": "13:00",
      "end": "14:30",
      "timezone": "Asia/Jakarta",
      "graceBeforeMinutes": 15,
      "graceAfterMinutes": 30
    }
  }
]
```

Keterangan:
- `nim`: kunci utama pencarian data mahasiswa.
- `nameMatch`: fallback jika NIM tidak cocok.
- `schedule.day`: hari kuliah (`Senin` s/d `Minggu`, atau English weekday).
- `schedule.start`/`schedule.end`: jam aktif format `HH:mm`.
- `graceBeforeMinutes`/`graceAfterMinutes`: toleransi menit sebelum/sesudah jam kuliah.
- Jika `schedule` tidak diisi, matkul akan dipantau sepanjang waktu.

## Catatan perilaku notifikasi

- Default notifikasi hanya dikirim untuk event kritikal (`Alfa`) saat `NOTIFY_MODE=critical`.
- Jika `NOTIFY_MODE=all`, semua perubahan/new pertemuan akan dikirim.
- Tidak spam berulang untuk event status yang sama (ada dedup di `state/state.json`).
- Saat `DRY_RUN=true`, pesan hanya dicetak ke console (tidak kirim ke Telegram).

## WhatsApp via Baileys

- Install dependency sudah termasuk `@whiskeysockets/baileys`.
- Atur env:
  - `WHATSAPP_ENABLE=true`
  - `WHATSAPP_TARGETS=628xxxxxxxxxx`
  - `NOTIFIER_CHANNEL=whatsapp` atau `both`
- Jalankan `npm start`, lalu scan QR di terminal ke WhatsApp Linked Devices.
- Session login disimpan di `state/wa_auth`.
- Command WA yang tersedia (private chat): `info`, `rekap`, `/info`, `/rekap`, `menu`.
- Batasi pengirim command lewat `WHATSAPP_ALLOWED_SENDERS` jika perlu.

## Command bot Telegram

- `/start`: menampilkan menu tombol `Rekap Absensi`.
- `/info` atau `/rekap`: bot refresh seluruh matkul lalu kirim rekap total dan per matkul.
- Rekap hanya menampilkan `Alfa`, `Izin`, `Sakit` (status `Hadir` tidak ditampilkan).
- Akses command bisa dibatasi via `TELEGRAM_ALLOWED_CHAT_IDS`.

## Menjalankan dengan PM2

```bash
pm2 start npm --name cekabsen -- start
pm2 save
pm2 startup
```
