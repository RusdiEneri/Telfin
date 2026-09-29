# Telfin 🧾

Bot Telegram ringan untuk mencatat pemasukan dan pengeluaran secara otomatis dari foto nota menggunakan TypeScript, grammY, better-sqlite3, dan AI Vision (Gemini / OpenAI).

---

## 🚀 Panduan Deploy di VPS Menggunakan PM2

### 1. Prasyarat
- Node.js LTS (v18+) & npm
- PM2 terpasang secara global:
  ```bash
  npm install -g pm2
  ```

### 2. Setup Proyek di VPS
Clone repositori dan pasang dependensi:
```bash
git clone https://github.com/RusdiEneri/Telfin
cd telfin
npm install
```

### 3. Konfigurasi Environment (.env)
Salin contoh file `.env.example` ke `.env`:
```bash
cp .env.example .env
nano .env
```
Isi variabel berikut:
```env
BOT_TOKEN=token_bot_dari_botfather
AI_PROVIDER=gemini
GEMINI_API_KEY=api_key_gemini_kamu
# NODE_ENV otomatis diset ke production oleh PM2
```

### 4. Build TypeScript
Kompilasi kode TypeScript ke folder `dist/`:
```bash
npm run build
```

### 5. Jalankan dengan PM2
Jalankan bot menggunakan file konfigurasi `ecosystem.config.js`:
```bash
pm2 start ecosystem.config.js
```

Simpan proses agar otomatis berjalan saat VPS reboot:
```bash
pm2 save
pm2 startup
```

---

## ⚙️ Perintah Manajemen PM2

- **Lihat Status Bot**:
  ```bash
  pm2 status
  ```
- **Pantau Log Realtime**:
  ```bash
  pm2 logs telfin
  ```
- **Lihat Log Error Fatal**:
  ```bash
  tail -f data/error.log
  ```
- **Restart Bot (Graceful)**:
  ```bash
  pm2 restart telfin
  ```
- **Hentikan Bot**:
  ```bash
  pm2 stop telfin
  ```

---

## 🛡️ Fitur Production & Keamanan
- **Auto Restart & Memory Limit**: Otomatis restart jika crash atau konsumsi memori melebihi 300MB (`max_memory_restart: "300M"`).
- **Graceful Shutdown**: Menutup polling Telegram (`bot.stop()`), membersihkan file temporary di `uploads/`, dan menutup koneksi SQLite secara aman saat menerima sinyal `SIGINT`/`SIGTERM`.
- **Production Logging**: Mencatat error fatal ke `data/error.log` saat `NODE_ENV=production`.
- **Anti-Double Input**: Mencegah pencatatan nota ganda dengan verifikasi hash SHA-256 sebelum memanggil AI.
