const fs = require("fs").promises;
const readline = require("readline");
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const pino = require("pino");

// ================= KONFIGURASI =================
const KONFIG = {
  NAMA_DEV: "Diks Store",
  FILE_TARGET: "./targets.json",
  FILE_STATISTIK: "./stats.json",
  FILE_LOG_JPM: "./log_jpm.json",
  FILE_SETTINGS: "./settings.json",
  FILE_BLACKLIST: "./blacklist.json",
  FILE_LOGS: "./logs.json",
  DIREKTORI_SESI: "./session",
  DIREKTORI_BACKUP: "./backups",
  LEVEL_LOG: "silent"
};

// ================= RATE LIMITER =================
class RateLimiter {
  constructor() {
    this.sentPerMinute = 0;
    this.sentPerHour = 0;
    this.sentPerDay = 0;
    this.lastMinuteReset = Date.now();
    this.lastHourReset = Date.now();
    this.lastDayReset = Date.now();
    this.MAX_PER_MINUTE = 15;
    this.MAX_PER_HOUR = 60;
    this.MAX_PER_DAY = 200;
  }

  async waitIfNeeded() {
    const now = Date.now();
    
    if (now - this.lastMinuteReset >= 60000) {
      this.sentPerMinute = 0;
      this.lastMinuteReset = now;
    }
    
    if (now - this.lastHourReset >= 3600000) {
      this.sentPerHour = 0;
      this.lastHourReset = now;
    }
    
    if (now - this.lastDayReset >= 86400000) {
      this.sentPerDay = 0;
      this.lastDayReset = now;
    }
    
    if (this.sentPerMinute >= this.MAX_PER_MINUTE) {
      const waitTime = 60000 - (now - this.lastMinuteReset);
      console.log(`⏰ Limit per menit tercapai, tunggu ${Math.ceil(waitTime/1000)} detik`);
      await Utility.tunda(waitTime);
      return this.waitIfNeeded();
    }
    
    if (this.sentPerHour >= this.MAX_PER_HOUR) {
      const waitTime = 3600000 - (now - this.lastHourReset);
      console.log(`⏰ Limit per jam tercapai, tunggu ${Math.ceil(waitTime/60000)} menit`);
      await Utility.tunda(waitTime);
      return this.waitIfNeeded();
    }
    
    if (this.sentPerDay >= this.MAX_PER_DAY) {
      console.log("📅 Limit harian tercapai! Hentikan pengiriman hari ini.");
      throw new Error("DAILY_LIMIT_REACHED");
    }
  }
  
  recordSent() {
    this.sentPerMinute++;
    this.sentPerHour++;
    this.sentPerDay++;
  }
  
  getStats() {
    return {
      perMinute: this.sentPerMinute,
      perHour: this.sentPerHour,
      perDay: this.sentPerDay,
      maxPerMinute: this.MAX_PER_MINUTE,
      maxPerHour: this.MAX_PER_HOUR,
      maxPerDay: this.MAX_PER_DAY
    };
  }
}
// ================= LOGGER =================
class Logger {
  constructor() {
    this.logs = [];
  }
  
  info(message, data = {}) {
    const log = { level: 'INFO', time: Date.now(), message, data };
    this.logs.push(log);
    console.log(`[INFO] ${message}`, Object.keys(data).length ? data : '');
    this.saveToFile();
  }
  
  error(message, error) {
    const log = { level: 'ERROR', time: Date.now(), message, error: error?.message || error };
    this.logs.push(log);
    console.error(`[ERROR] ${message}`, error?.message || error);
    this.saveToFile();
  }
  
  warn(message, data = {}) {
    const log = { level: 'WARN', time: Date.now(), message, data };
    this.logs.push(log);
    console.warn(`[WARN] ${message}`, Object.keys(data).length ? data : '');
    this.saveToFile();
  }
  
  async saveToFile() {
    try {
      const logsToSave = this.logs.slice(-1000);
      await fs.writeFile(KONFIG.FILE_LOGS, JSON.stringify(logsToSave, null, 2));
    } catch (error) {
      console.error("Gagal menyimpan log:", error.message);
    }
  }
  
  getRecent(limit = 50) {
    return this.logs.slice(-limit);
  }
}

// ================= UTILITY =================
class Utility {
  static bersihkanNomor(nomor) { return nomor.replace(/[^\d]/g, ""); }
  
  static keJid(nomor) {
    let bersih = this.bersihkanNomor(nomor);
    if (bersih.startsWith("0")) bersih = "62" + bersih.slice(1);
    return bersih + "@s.whatsapp.net";
  }

  static jidAman(jid) { return jid && !jid.includes("@lid") ? jid : null; }
  static tunda(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  
  static ekstrakTeksPesan(msg) {
    return msg.message?.conversation ||
           msg.message?.extendedTextMessage?.text ||
           msg.message?.imageMessage?.caption || "";
  }

  static formatWaktu(timestamp) {
    return new Date(timestamp).toLocaleString('id-ID');
  }

  static formatDurasi(ms) {
    const detik = Math.floor(ms / 1000);
    const jam = Math.floor(detik / 3600);
    const menit = Math.floor((detik % 3600) / 60);
    const dtk = detik % 60;
    if (jam > 0) return `${jam}j ${menit}m ${dtk}d`;
    if (menit > 0) return `${menit}m ${dtk}d`;
    return `${dtk}d`;
  }

  static formatDelay(ms) { return `${ms/1000} detik`; }
}
// ================= MANAJER DATA =================
class ManajerData {
  constructor() {
    this.target = [];
    this.blacklist = new Set();
    this.statistik = {
      terkirim: 0,
      gagal: 0,
      waktuMulai: Date.now(),
      totalJPM: 0,
      riwayatJPM: []
    };
    this.pesanKustom = "Halo bang 🔔";
    this.pengaturan = {
      delay: 15000,
      minDelay: 10000,
      maxDelay: 30000,
      autoProgress: true,
      notifikasiGagal: true,
      randomDelay: true,
      useVariasi: true,
      maxPerDay: 200,
      maxPerHour: 60,
      activeHours: { start: 8, end: 20 }
    };
  }

  async muat() {
    try {
      const [dataTarget, dataStatistik, dataLogJPM, dataPengaturan, dataBlacklist] = await Promise.all([
        this._bacaJson(KONFIG.FILE_TARGET),
        this._bacaJson(KONFIG.FILE_STATISTIK),
        this._bacaJson(KONFIG.FILE_LOG_JPM),
        this._bacaJson(KONFIG.FILE_SETTINGS),
        this._bacaJson(KONFIG.FILE_BLACKLIST)
      ]);
      
      this.target = dataTarget || [];
      if (dataStatistik) this.statistik = { ...this.statistik, ...dataStatistik };
      if (dataLogJPM) this.statistik.riwayatJPM = dataLogJPM;
      if (dataPengaturan) this.pengaturan = { ...this.pengaturan, ...dataPengaturan };
      if (dataBlacklist) this.blacklist = new Set(dataBlacklist);
    } catch (error) {
      console.log("⚠️ Tidak ada data lama");
    }
  }

  async _bacaJson(jalurFile) {
    try {
      const data = await fs.readFile(jalurFile, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async _tulisJson(jalurFile, data) {
    await fs.writeFile(jalurFile, JSON.stringify(data, null, 2));
  }

  async simpanSemua() {
    await Promise.all([
      this._tulisJson(KONFIG.FILE_TARGET, this.target),
      this._tulisJson(KONFIG.FILE_STATISTIK, this.statistik),
      this._tulisJson(KONFIG.FILE_LOG_JPM, this.statistik.riwayatJPM),
      this._tulisJson(KONFIG.FILE_SETTINGS, this.pengaturan),
      this._tulisJson(KONFIG.FILE_BLACKLIST, Array.from(this.blacklist))
    ]);
  }

  tambahTarget(jid) {
    if (!this.target.includes(jid) && !this.blacklist.has(jid)) {
      this.target.push(jid);
      return true;
    }
    return false;
  }

  hapusTarget(jid) {
    const panjangAwal = this.target.length;
    this.target = this.target.filter(x => x !== jid);
    return panjangAwal !== this.target.length;
  }
  
  addToBlacklist(jid) {
    this.blacklist.add(jid);
    this.target = this.target.filter(x => x !== jid);
    this.simpanSemua();
  }
  
  isBlacklisted(jid) {
    return this.blacklist.has(jid);
  }

  tambahTerkirim() { this.statistik.terkirim++; }
  tambahGagal() { this.statistik.gagal++; }
  resetStatistikSesi() { this.statistik.terkirim = 0; this.statistik.gagal = 0; }

  dapatkanWaktuJalan() {
    const detik = Math.floor((Date.now() - this.statistik.waktuMulai) / 1000);
    return `${Math.floor(detik / 3600)}j ${Math.floor((detik % 3600) / 60)}m ${detik % 60}d`;
  }

  dapatkanPesanKustom() { return this.pesanKustom; }
  setPesanKustom(pesan) { this.pesanKustom = pesan; }
  
  dapatkanDelay() { return this.pengaturan.delay; }
  dapatkanDelayRange() { return { min: this.pengaturan.minDelay, max: this.pengaturan.maxDelay }; }
  
  setDelay(ms) { 
    this.pengaturan.delay = Math.max(5000, Math.min(60000, ms));
    this.pengaturan.minDelay = Math.max(5000, this.pengaturan.delay - 5000);
    this.pengaturan.maxDelay = Math.min(60000, this.pengaturan.delay + 5000);
    this.simpanSemua();
  }
  
  dapatkanPengaturan() { return this.pengaturan; }
  setPengaturan(key, value) { 
    this.pengaturan[key] = value; 
    this.simpanSemua(); 
  }
  
  isActiveHours() {
    const now = new Date();
    const hour = now.getHours();
    const { start, end } = this.pengaturan.activeHours;
    return hour >= start && hour < end;
  }
  
  getVariasiPesan(pesan) {
    const variasi = [
      pesan,
      `${pesan} 🙏`,
      `${pesan} 😊`,
      `${pesan} ✨`,
      `${pesan} 🙏😊`,
      `Halo, ${pesan.toLowerCase()}`,
      `${pesan} \n\nTerima kasih 🙏`,
      `✨ ${pesan} ✨`,
    ];
    return variasi[Math.floor(Math.random() * variasi.length)];
  }

  tambahRiwayatJPM(data) {
    this.statistik.riwayatJPM.unshift(data);
    this.statistik.totalJPM = this.statistik.riwayatJPM.length;
    if (this.statistik.riwayatJPM.length > 50) this.statistik.riwayatJPM = this.statistik.riwayatJPM.slice(0, 50);
  }
  
  async backupData() {
    try {
      await fs.mkdir(KONFIG.DIREKTORI_BACKUP, { recursive: true });
      const tanggal = new Date().toISOString().slice(0, 10);
      const backupDir = `${KONFIG.DIREKTORI_BACKUP}/${tanggal}`;
      await fs.mkdir(backupDir, { recursive: true });
      
      const files = [
        KONFIG.FILE_TARGET,
        KONFIG.FILE_STATISTIK,
        KONFIG.FILE_LOG_JPM,
        KONFIG.FILE_SETTINGS,
        KONFIG.FILE_BLACKLIST
      ];
      
      for (const file of files) {
        try {
          await fs.copyFile(file, `${backupDir}/${path.basename(file)}`);
        } catch (e) {}
      }
      
      console.log(`💾 Backup data ke ${backupDir}`);
    } catch (error) {
      console.error("Gagal backup:", error.message);
    }
  }
}
// ================= PENANGAN PESAN =================
class PenanganPesan {
  constructor(sock, data, state, logger) {
    this.sock = sock;
    this.data = data;
    this.state = state;
    this.logger = logger;
  }

  async tanganiPesan(jid, teks) {
    const cmd = teks.trim();
    
    if (cmd === ".menu") return this._menu(jid);
    if (cmd.startsWith(".add ")) return this._add(jid, cmd);
    if (cmd.startsWith(".remove ")) return this._remove(jid, cmd);
    if (cmd === ".list") return this._list(jid);
    if (cmd === ".sendall") return this._sendall(jid);
    if (cmd === ".stop") return this._stop(jid);
    if (cmd.startsWith(".setmsg ")) return this._setmsg(jid, cmd);
    if (cmd === ".stats") return this._stats(jid);
    if (cmd === ".history") return this._history(jid);
    if (cmd === ".resetstats") return this._resetstats(jid);
    if (cmd === ".delay") return this._lihatDelay(jid);
    if (cmd.startsWith(".delay ")) return this._setDelay(jid, cmd);
    if (cmd === ".delayfast") return this._setDelayCepat(jid);
    if (cmd === ".delaynormal") return this._setDelayNormal(jid);
    if (cmd === ".delayslow") return this._setDelayLambat(jid);
    if (cmd === ".delayverylow") return this._setDelaySangatLambat(jid);
    if (cmd === ".settings") return this._settings(jid);
    if (cmd === ".autoprogress") return this._toggleProgress(jid);
    if (cmd === ".notifgagal") return this._toggleNotif(jid);
    if (cmd === ".randomdelay") return this._toggleRandomDelay(jid);
    if (cmd === ".variasi") return this._toggleVariasi(jid);
    if (cmd === ".status") return this._status(jid);
    if (cmd === ".blacklist") return this._lihatBlacklist(jid);
    if (cmd.startsWith(".unblacklist ")) return this._unblacklist(jid, cmd);
    if (cmd === ".backup") return this._backup(jid);
    if (cmd.startsWith(".music ") || cmd.startsWith(".play ")) return this._music(jid, cmd);
  }

  async _menu(jid) {
    const delay = Utility.formatDelay(this.data.dapatkanDelay());
    const pengaturan = this.data.dapatkanPengaturan();
    const stats = this.data.statistik;
    const rateStats = this.state.rateLimiter?.getStats() || {};
    
    await this.sock.sendMessage(jid, { text: `
╭━━━ 🔒 SAFE JPM BOT v2 ━━━╮
┃ 👨‍💻 Dev : ${KONFIG.NAMA_DEV}
┃ 🛡 Mode : ANTI-BAN ACTIVE
╰━━━━━━━━━━━━━━━━━━━━━━╯

📋 PERINTAH:
├ .add <nomor> - Tambah target
├ .remove <nomor> - Hapus target
├ .list - Lihat target
├ .sendall - Kirim ke semua
├ .stop - Hentikan kirim
├ .setmsg <teks> - Ganti pesan
├ .delay - Lihat delay
├ .delay <detik> - Set delay (min 5dtk)
├ .delayfast (10dtk) | .delaynormal (15dtk)
├ .delayslow (25dtk) | .delayverylow (40dtk)
├ .randomdelay - Acak delay ON/OFF
├ .variasi - Variasi pesan ON/OFF
├ .stats - Statistik lengkap
├ .history - Riwayat JPM
├ .status - Status rate limit
├ .blacklist - Lihat blacklist
├ .settings - Pengaturan
└ .music <judul> - Cari musik

⚙️ PENGATURAN AMAN:
├ ⏱ Delay: ${delay}
├ 🎲 Random Delay: ${pengaturan.randomDelay ? 'ON' : 'OFF'}
├ 📝 Variasi Pesan: ${pengaturan.useVariasi ? 'ON' : 'OFF'}
├ 📊 Auto Progress: ${pengaturan.autoProgress ? 'ON' : 'OFF'}
├ 🔔 Notif Gagal: ${pengaturan.notifikasiGagal ? 'ON' : 'OFF'}
└ ⏰ Aktif: ${pengaturan.activeHours.start}:00-${pengaturan.activeHours.end}:00

📊 LIMIT AMAN:
├ 📅 Max/hari: ${pengaturan.maxPerDay}
├ 📊 Max/jam: ${pengaturan.maxPerHour}
└ ⏱ Rate saat ini: ${rateStats.perMinute || 0}/mnt | ${rateStats.perHour || 0}/jam | ${rateStats.perDay || 0}/hari

📊 STATISTIK:
├✅ Terkirim: ${stats.terkirim}
├❌ Gagal: ${stats.gagal}
├👥 Target: ${this.data.target.length}
├🚫 Blacklist: ${this.data.blacklist.size}
└⏱ Uptime: ${this.data.dapatkanWaktuJalan()}

⚠️ PERINGATAN: Gunakan delay minimal 10 detik!
    `});
  }

  async _lihatDelay(jid) {
    const delay = this.data.dapatkanDelay();
    const range = this.data.dapatkanDelayRange();
    const targetCount = this.data.target.length;
    const estimasi = Utility.formatDurasi(delay * targetCount);
    
    await this.sock.sendMessage(jid, { text: `
⏱ PENGATURAN DELAY SAAT INI:
├ Delay tetap: ${Utility.formatDelay(delay)}
├ Range acak: ${Utility.formatDelay(range.min)} - ${Utility.formatDelay(range.max)}
└ Random delay: ${this.data.pengaturan.randomDelay ? 'AKTIF 🎲' : 'NONAKTIF'}

📊 ESTIMASI WAKTU:
├ 10 target: ${Utility.formatDurasi(delay * 10)}
├ 50 target: ${Utility.formatDurasi(delay * 50)}
├ 100 target: ${Utility.formatDurasi(delay * 100)}
└ ${targetCount} target: ${estimasi}

💡 DELAY AMAN (Rekomendasi):
├ Aman: 15-30 detik
├ Cukup Aman: 10-15 detik
├ Berisiko: 5-10 detik
└ ❌ Dilarang: <5 detik

💡 CARA UBAH:
├ .delay 15 (15 detik)
├ .delayfast (10 detik)
├ .delaynormal (15 detik)
├ .delayslow (25 detik)
└ .delayverylow (40 detik)
    `});
  }

  async _setDelay(jid, cmd) {
    const detik = parseFloat(cmd.replace(".delay ", ""));
    if (isNaN(detik) || detik <= 0) {
      return this.sock.sendMessage(jid, { text: "⚠️ Format salah! Contoh: .delay 15" });
    }
    
    if (detik < 5) {
      return this.sock.sendMessage(jid, { text: "❌ Delay minimal 5 detik untuk keamanan akun!" });
    }
    
    const lama = this.data.dapatkanDelay();
    this.data.setDelay(detik * 1000);
    
    let peringatan = "";
    if (detik < 10) peringatan = "\n⚠️ PERINGATAN: Delay <10 detik BERISIKO TINGGI!";
    else if (detik < 15) peringatan = "\n⚠️ Delay ini cukup aman, tapi tetap waspada!";
    else peringatan = "\n✅ Delay aman untuk penggunaan JPM.";
    
    await this.sock.sendMessage(jid, { text: `✅ Delay diubah\n⏱ Sebelum: ${Utility.formatDelay(lama)}\n⏱ Sekarang: ${detik} detik${peringatan}` });
    this.logger.info(`Delay diubah ke ${detik} detik oleh ${jid}`);
  }

  async _setDelayCepat(jid) { 
    this.data.setDelay(10000); 
    await this.sock.sendMessage(jid, { text: "⚡ Delay: CEPAT (10 detik) - Cukup aman" }); 
  }
  
  async _setDelayNormal(jid) { 
    this.data.setDelay(15000); 
    await this.sock.sendMessage(jid, { text: "✅ Delay: NORMAL (15 detik) - Recommended" }); 
  }
  
  async _setDelayLambat(jid) { 
    this.data.setDelay(25000); 
    await this.sock.sendMessage(jid, { text: "🐢 Delay: LAMBAT (25 detik) - Sangat aman" }); 
  }
  
  async _setDelaySangatLambat(jid) { 
    this.data.setDelay(40000); 
    await this.sock.sendMessage(jid, { text: "🐌 Delay: SANGAT LAMBAT (40 detik) - Extra aman" }); 
  }

  async _toggleRandomDelay(jid) {
    const baru = !this.data.pengaturan.randomDelay;
    this.data.setPengaturan("randomDelay", baru);
    await this.sock.sendMessage(jid, { text: `🎲 Random Delay: ${baru ? 'ON ✅' : 'OFF ❌'}\n${baru ? 'Delay akan bervariasi antara 10-30 detik' : 'Delay akan tetap'}` });
  }
  
  async _toggleVariasi(jid) {
    const baru = !this.data.pengaturan.useVariasi;
    this.data.setPengaturan("useVariasi", baru);
    await this.sock.sendMessage(jid, { text: `📝 Variasi Pesan: ${baru ? 'ON ✅' : 'OFF ❌'}\n${baru ? 'Pesan akan sedikit bervariasi' : 'Pesan akan sama setiap kirim'}` });
  }

  async _settings(jid) {
    const set = this.data.dapatkanPengaturan();
    await this.sock.sendMessage(jid, { text: `
⚙️ PENGATURAN BOT:
├ ⏱ Delay: ${Utility.formatDelay(set.delay)}
├ 🎲 Random Delay: ${set.randomDelay ? 'ON' : 'OFF'}
├ 📝 Variasi Pesan: ${set.useVariasi ? 'ON' : 'OFF'}
├ 📊 Auto Progress: ${set.autoProgress ? 'ON' : 'OFF'}
├ 🔔 Notif Gagal: ${set.notifikasiGagal ? 'ON' : 'OFF'}
├ 📅 Max per Hari: ${set.maxPerDay}
├ 📊 Max per Jam: ${set.maxPerHour}
└ ⏰ Jam Aktif: ${set.activeHours.start}:00 - ${set.activeHours.end}:00

💡 Ubah dengan:
├ .delay <detik>
├ .randomdelay
├ .variasi
├ .autoprogress
└ .notifgagal
    `});
  }

  async _toggleProgress(jid) {
    const baru = !this.data.pengaturan.autoProgress;
    this.data.setPengaturan("autoProgress", baru);
    await this.sock.sendMessage(jid, { text: `📊 Auto Progress: ${baru ? 'ON ✅' : 'OFF ❌'}` });
  }

  async _toggleNotif(jid) {
    const baru = !this.data.pengaturan.notifikasiGagal;
    this.data.setPengaturan("notifikasiGagal", baru);
    await this.sock.sendMessage(jid, { text: `🔔 Notif Gagal: ${baru ? 'ON ✅' : 'OFF ❌'}` });
  }
  
  async _status(jid) {
    const rateStats = this.state.rateLimiter?.getStats() || {};
    const isActive = this.data.isActiveHours();
    await this.sock.sendMessage(jid, { text: `
📊 STATUS RATE LIMIT:
├ 📅 Hari ini: ${rateStats.perDay || 0}/${this.data.pengaturan.maxPerDay}
├ 📊 Jam ini: ${rateStats.perHour || 0}/${this.data.pengaturan.maxPerHour}
├ ⏱ Menit ini: ${rateStats.perMinute || 0}/${rateStats.maxPerMinute || 15}
└ ⏰ Jam Aktif: ${isActive ? '✅ AKTIF' : '⏸ NONAKTIF'}

🎯 SISA KIRIM HARI INI:
├ ${Math.max(0, this.data.pengaturan.maxPerDay - (rateStats.perDay || 0))} pesan
└ Estimasi: ${Utility.formatDurasi(Math.max(0, this.data.pengaturan.maxPerDay - (rateStats.perDay || 0)) * this.data.dapatkanDelay())}
    `});
  }
  
  async _lihatBlacklist(jid) {
    const blacklist = Array.from(this.data.blacklist);
    if (blacklist.length === 0) {
      return this.sock.sendMessage(jid, { text: "📭 Blacklist kosong" });
    }
    
    let teks = `🚫 BLACKLIST (${blacklist.length}):\n\n`;
    blacklist.slice(0, 20).forEach((item, i) => {
      teks += `${i+1}. ${item}\n`;
    });
    
    if (blacklist.length > 20) {
      teks += `\n... dan ${blacklist.length - 20} lainnya`;
    }
    
    teks += `\n\n💡 Hapus dengan: .unblacklist <nomor>`;
    await this.sock.sendMessage(jid, { text: teks });
  }
  
  async _unblacklist(jid, cmd) {
    const nomor = cmd.replace(".unblacklist ", "").trim();
    const jidTarget = Utility.keJid(nomor);
    
    if (this.data.blacklist.has(jidTarget)) {
      this.data.blacklist.delete(jidTarget);
      await this.data.simpanSemua();
      await this.sock.sendMessage(jid, { text: `✅ ${jidTarget} dihapus dari blacklist` });
    } else {
      await this.sock.sendMessage(jid, { text: `⚠️ ${jidTarget} tidak ada di blacklist` });
    }
  }
  
  async _backup(jid) {
    await this.data.backupData();
    await this.sock.sendMessage(jid, { text: "💾 Backup data berhasil dilakukan!" });
  }
// ================= PENANGAN PESAN =================
class PenanganPesan {
  constructor(sock, data, state, logger) {
    this.sock = sock;
    this.data = data;
    this.state = state;
    this.logger = logger;
  }

  async tanganiPesan(jid, teks) {
    const cmd = teks.trim();
    
    if (cmd === ".menu") return this._menu(jid);
    if (cmd.startsWith(".add ")) return this._add(jid, cmd);
    if (cmd.startsWith(".remove ")) return this._remove(jid, cmd);
    if (cmd === ".list") return this._list(jid);
    if (cmd === ".sendall") return this._sendall(jid);
    if (cmd === ".stop") return this._stop(jid);
    if (cmd.startsWith(".setmsg ")) return this._setmsg(jid, cmd);
    if (cmd === ".stats") return this._stats(jid);
    if (cmd === ".history") return this._history(jid);
    if (cmd === ".resetstats") return this._resetstats(jid);
    if (cmd === ".delay") return this._lihatDelay(jid);
    if (cmd.startsWith(".delay ")) return this._setDelay(jid, cmd);
    if (cmd === ".delayfast") return this._setDelayCepat(jid);
    if (cmd === ".delaynormal") return this._setDelayNormal(jid);
    if (cmd === ".delayslow") return this._setDelayLambat(jid);
    if (cmd === ".delayverylow") return this._setDelaySangatLambat(jid);
    if (cmd === ".settings") return this._settings(jid);
    if (cmd === ".autoprogress") return this._toggleProgress(jid);
    if (cmd === ".notifgagal") return this._toggleNotif(jid);
    if (cmd === ".randomdelay") return this._toggleRandomDelay(jid);
    if (cmd === ".variasi") return this._toggleVariasi(jid);
    if (cmd === ".status") return this._status(jid);
    if (cmd === ".blacklist") return this._lihatBlacklist(jid);
    if (cmd.startsWith(".unblacklist ")) return this._unblacklist(jid, cmd);
    if (cmd === ".backup") return this._backup(jid);
    if (cmd.startsWith(".music ") || cmd.startsWith(".play ")) return this._music(jid, cmd);
  }

  async _menu(jid) {
    const delay = Utility.formatDelay(this.data.dapatkanDelay());
    const pengaturan = this.data.dapatkanPengaturan();
    const stats = this.data.statistik;
    const rateStats = this.state.rateLimiter?.getStats() || {};
    
    await this.sock.sendMessage(jid, { text: `
╭━━━ 🔒 SAFE JPM BOT v2 ━━━╮
┃ 👨‍💻 Dev : ${KONFIG.NAMA_DEV}
┃ 🛡 Mode : ANTI-BAN ACTIVE
╰━━━━━━━━━━━━━━━━━━━━━━╯

📋 PERINTAH:
├ .add <nomor> - Tambah target
├ .remove <nomor> - Hapus target
├ .list - Lihat target
├ .sendall - Kirim ke semua
├ .stop - Hentikan kirim
├ .setmsg <teks> - Ganti pesan
├ .delay - Lihat delay
├ .delay <detik> - Set delay (min 5dtk)
├ .delayfast (10dtk) | .delaynormal (15dtk)
├ .delayslow (25dtk) | .delayverylow (40dtk)
├ .randomdelay - Acak delay ON/OFF
├ .variasi - Variasi pesan ON/OFF
├ .stats - Statistik lengkap
├ .history - Riwayat JPM
├ .status - Status rate limit
├ .blacklist - Lihat blacklist
├ .settings - Pengaturan
└ .music <judul> - Cari musik

⚙️ PENGATURAN AMAN:
├ ⏱ Delay: ${delay}
├ 🎲 Random Delay: ${pengaturan.randomDelay ? 'ON' : 'OFF'}
├ 📝 Variasi Pesan: ${pengaturan.useVariasi ? 'ON' : 'OFF'}
├ 📊 Auto Progress: ${pengaturan.autoProgress ? 'ON' : 'OFF'}
├ 🔔 Notif Gagal: ${pengaturan.notifikasiGagal ? 'ON' : 'OFF'}
└ ⏰ Aktif: ${pengaturan.activeHours.start}:00-${pengaturan.activeHours.end}:00

📊 LIMIT AMAN:
├ 📅 Max/hari: ${pengaturan.maxPerDay}
├ 📊 Max/jam: ${pengaturan.maxPerHour}
└ ⏱ Rate saat ini: ${rateStats.perMinute || 0}/mnt | ${rateStats.perHour || 0}/jam | ${rateStats.perDay || 0}/hari

📊 STATISTIK:
├✅ Terkirim: ${stats.terkirim}
├❌ Gagal: ${stats.gagal}
├👥 Target: ${this.data.target.length}
├🚫 Blacklist: ${this.data.blacklist.size}
└⏱ Uptime: ${this.data.dapatkanWaktuJalan()}

⚠️ PERINGATAN: Gunakan delay minimal 10 detik!
    `});
  }

  async _lihatDelay(jid) {
    const delay = this.data.dapatkanDelay();
    const range = this.data.dapatkanDelayRange();
    const targetCount = this.data.target.length;
    const estimasi = Utility.formatDurasi(delay * targetCount);
    
    await this.sock.sendMessage(jid, { text: `
⏱ PENGATURAN DELAY SAAT INI:
├ Delay tetap: ${Utility.formatDelay(delay)}
├ Range acak: ${Utility.formatDelay(range.min)} - ${Utility.formatDelay(range.max)}
└ Random delay: ${this.data.pengaturan.randomDelay ? 'AKTIF 🎲' : 'NONAKTIF'}

📊 ESTIMASI WAKTU:
├ 10 target: ${Utility.formatDurasi(delay * 10)}
├ 50 target: ${Utility.formatDurasi(delay * 50)}
├ 100 target: ${Utility.formatDurasi(delay * 100)}
└ ${targetCount} target: ${estimasi}

💡 DELAY AMAN (Rekomendasi):
├ Aman: 15-30 detik
├ Cukup Aman: 10-15 detik
├ Berisiko: 5-10 detik
└ ❌ Dilarang: <5 detik

💡 CARA UBAH:
├ .delay 15 (15 detik)
├ .delayfast (10 detik)
├ .delaynormal (15 detik)
├ .delayslow (25 detik)
└ .delayverylow (40 detik)
    `});
  }

  async _setDelay(jid, cmd) {
    const detik = parseFloat(cmd.replace(".delay ", ""));
    if (isNaN(detik) || detik <= 0) {
      return this.sock.sendMessage(jid, { text: "⚠️ Format salah! Contoh: .delay 15" });
    }
    
    if (detik < 5) {
      return this.sock.sendMessage(jid, { text: "❌ Delay minimal 5 detik untuk keamanan akun!" });
    }
    
    const lama = this.data.dapatkanDelay();
    this.data.setDelay(detik * 1000);
    
    let peringatan = "";
    if (detik < 10) peringatan = "\n⚠️ PERINGATAN: Delay <10 detik BERISIKO TINGGI!";
    else if (detik < 15) peringatan = "\n⚠️ Delay ini cukup aman, tapi tetap waspada!";
    else peringatan = "\n✅ Delay aman untuk penggunaan JPM.";
    
    await this.sock.sendMessage(jid, { text: `✅ Delay diubah\n⏱ Sebelum: ${Utility.formatDelay(lama)}\n⏱ Sekarang: ${detik} detik${peringatan}` });
    this.logger.info(`Delay diubah ke ${detik} detik oleh ${jid}`);
  }

  async _setDelayCepat(jid) { 
    this.data.setDelay(10000); 
    await this.sock.sendMessage(jid, { text: "⚡ Delay: CEPAT (10 detik) - Cukup aman" }); 
  }
  
  async _setDelayNormal(jid) { 
    this.data.setDelay(15000); 
    await this.sock.sendMessage(jid, { text: "✅ Delay: NORMAL (15 detik) - Recommended" }); 
  }
  
  async _setDelayLambat(jid) { 
    this.data.setDelay(25000); 
    await this.sock.sendMessage(jid, { text: "🐢 Delay: LAMBAT (25 detik) - Sangat aman" }); 
  }
  
  async _setDelaySangatLambat(jid) { 
    this.data.setDelay(40000); 
    await this.sock.sendMessage(jid, { text: "🐌 Delay: SANGAT LAMBAT (40 detik) - Extra aman" }); 
  }

  async _toggleRandomDelay(jid) {
    const baru = !this.data.pengaturan.randomDelay;
    this.data.setPengaturan("randomDelay", baru);
    await this.sock.sendMessage(jid, { text: `🎲 Random Delay: ${baru ? 'ON ✅' : 'OFF ❌'}\n${baru ? 'Delay akan bervariasi antara 10-30 detik' : 'Delay akan tetap'}` });
  }
  
  async _toggleVariasi(jid) {
    const baru = !this.data.pengaturan.useVariasi;
    this.data.setPengaturan("useVariasi", baru);
    await this.sock.sendMessage(jid, { text: `📝 Variasi Pesan: ${baru ? 'ON ✅' : 'OFF ❌'}\n${baru ? 'Pesan akan sedikit bervariasi' : 'Pesan akan sama setiap kirim'}` });
  }

  async _settings(jid) {
    const set = this.data.dapatkanPengaturan();
    await this.sock.sendMessage(jid, { text: `
⚙️ PENGATURAN BOT:
├ ⏱ Delay: ${Utility.formatDelay(set.delay)}
├ 🎲 Random Delay: ${set.randomDelay ? 'ON' : 'OFF'}
├ 📝 Variasi Pesan: ${set.useVariasi ? 'ON' : 'OFF'}
├ 📊 Auto Progress: ${set.autoProgress ? 'ON' : 'OFF'}
├ 🔔 Notif Gagal: ${set.notifikasiGagal ? 'ON' : 'OFF'}
├ 📅 Max per Hari: ${set.maxPerDay}
├ 📊 Max per Jam: ${set.maxPerHour}
└ ⏰ Jam Aktif: ${set.activeHours.start}:00 - ${set.activeHours.end}:00

💡 Ubah dengan:
├ .delay <detik>
├ .randomdelay
├ .variasi
├ .autoprogress
└ .notifgagal
    `});
  }

  async _toggleProgress(jid) {
    const baru = !this.data.pengaturan.autoProgress;
    this.data.setPengaturan("autoProgress", baru);
    await this.sock.sendMessage(jid, { text: `📊 Auto Progress: ${baru ? 'ON ✅' : 'OFF ❌'}` });
  }

  async _toggleNotif(jid) {
    const baru = !this.data.pengaturan.notifikasiGagal;
    this.data.setPengaturan("notifikasiGagal", baru);
    await this.sock.sendMessage(jid, { text: `🔔 Notif Gagal: ${baru ? 'ON ✅' : 'OFF ❌'}` });
  }
  
  async _status(jid) {
    const rateStats = this.state.rateLimiter?.getStats() || {};
    const isActive = this.data.isActiveHours();
    await this.sock.sendMessage(jid, { text: `
📊 STATUS RATE LIMIT:
├ 📅 Hari ini: ${rateStats.perDay || 0}/${this.data.pengaturan.maxPerDay}
├ 📊 Jam ini: ${rateStats.perHour || 0}/${this.data.pengaturan.maxPerHour}
├ ⏱ Menit ini: ${rateStats.perMinute || 0}/${rateStats.maxPerMinute || 15}
└ ⏰ Jam Aktif: ${isActive ? '✅ AKTIF' : '⏸ NONAKTIF'}

🎯 SISA KIRIM HARI INI:
├ ${Math.max(0, this.data.pengaturan.maxPerDay - (rateStats.perDay || 0))} pesan
└ Estimasi: ${Utility.formatDurasi(Math.max(0, this.data.pengaturan.maxPerDay - (rateStats.perDay || 0)) * this.data.dapatkanDelay())}
    `});
  }
  
  async _lihatBlacklist(jid) {
    const blacklist = Array.from(this.data.blacklist);
    if (blacklist.length === 0) {
      return this.sock.sendMessage(jid, { text: "📭 Blacklist kosong" });
    }
    
    let teks = `🚫 BLACKLIST (${blacklist.length}):\n\n`;
    blacklist.slice(0, 20).forEach((item, i) => {
      teks += `${i+1}. ${item}\n`;
    });
    
    if (blacklist.length > 20) {
      teks += `\n... dan ${blacklist.length - 20} lainnya`;
    }
    
    teks += `\n\n💡 Hapus dengan: .unblacklist <nomor>`;
    await this.sock.sendMessage(jid, { text: teks });
  }
  
  async _unblacklist(jid, cmd) {
    const nomor = cmd.replace(".unblacklist ", "").trim();
    const jidTarget = Utility.keJid(nomor);
    
    if (this.data.blacklist.has(jidTarget)) {
      this.data.blacklist.delete(jidTarget);
      await this.data.simpanSemua();
      await this.sock.sendMessage(jid, { text: `✅ ${jidTarget} dihapus dari blacklist` });
    } else {
      await this.sock.sendMessage(jid, { text: `⚠️ ${jidTarget} tidak ada di blacklist` });
    }
  }
  
  async _backup(jid) {
    await this.data.backupData();
    await this.sock.sendMessage(jid, { text: "💾 Backup data berhasil dilakukan!" });
  }
}
// ================= BOT =================
class BotWhatsApp {
  constructor() {
    this.data = new ManajerData();
    this.logger = new Logger();
    this.rateLimiter = new RateLimiter();
    this.state = { 
      sedangBerjalan: false,
      rateLimiter: this.rateLimiter
    };
  }

  async start() {
    console.log("🚀 Memulai bot aman mode...");
    console.log("⚠️ PENTING: Gunakan delay minimal 10 detik untuk keamanan akun!");
    console.log("📱 Ketik .menu di chat WhatsApp untuk melihat perintah");
    
    await this.data.muat();
    await this.data.backupData();
    
    const { state, saveCreds } = await useMultiFileAuthState(KONFIG.DIREKTORI_SESI);
    const { version } = await fetchLatestBaileysVersion();
    
    this.sock = makeWASocket({ 
      version, 
      logger: pino({ level: KONFIG.LEVEL_LOG }), 
      auth: state,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: false
    });
    
    this.sock.ev.on("creds.update", saveCreds);
    
    this.handler = new PenanganPesan(this.sock, this.data, this.state, this.logger);
    this.sock.ev.on("connection.update", this._handleConn.bind(this));
    this.sock.ev.on("messages.upsert", this._handleMsg.bind(this));
    
    if (!this.sock.authState.creds.registered) {
      await this._pairing();
    }
    
    console.log("📡 Bot aman siap -", KONFIG.NAMA_DEV);
    console.log("✅ Proteksi anti-ban aktif!");
    this.logger.info("Bot aman started");
  }

  async _handleConn(update) {
    if (update.connection === "open") {
      console.log("✅ Terhubung:", this.sock.user.id);
      console.log("📱 JID Anda:", this.sock.user.id);
      this.logger.info(`Connected: ${this.sock.user.id}`);
      
      try {
        await this.sock.sendMessage(this.sock.user.id, { 
          text: `✅ BOT AKTIF!\n\nKetik .menu untuk melihat semua perintah\n\n⚠️ PERINGATAN:\n- Gunakan delay minimal 10 detik\n- Maks 200 pesan/hari\n- Bot aktif jam 08:00-20:00` 
        });
      } catch (e) {}
    }
    
    if (update.connection === "close") {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("🔄 Koneksi terputus, mencoba ulang dalam 5 detik...");
        this.logger.warn(`Disconnected, reason: ${statusCode}`);
        setTimeout(() => this.start(), 5000);
      } else {
        console.log("👋 Session logged out, hapus folder session dan scan ulang");
        this.logger.error("Session logged out");
      }
    }
  }

  async _handleMsg({ messages }) {
    const msg = messages[0];
    if (!msg.message) return;
    
    const teks = Utility.ekstrakTeksPesan(msg);
    console.log("📩 Pesan dari:", msg.key.remoteJid, "| Teks:", teks);
    
    if (teks && teks.startsWith(".")) {
      console.log("⚡ Memproses perintah:", teks);
      await this.handler.tanganiPesan(msg.key.remoteJid, teks);
    }
  }

  async _pairing() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("📱 Masukkan nomor WhatsApp (contoh: 628xxxxxxxx): ", async (nomor) => {
      try {
        const bersih = Utility.bersihkanNomor(nomor);
        console.log("🔑 Meminta kode pairing...");
        const code = await this.sock.requestPairingCode(bersih);
        console.log(`🔐 KODE PAIRING: ${code}`);
        console.log("📱 Masukkan kode di WhatsApp Anda");
        this.logger.info(`Pairing code requested for ${bersih}`);
      } catch (e) { 
        console.log("❌ Error:", e.message);
        this.logger.error("Pairing failed", e);
      }
      rl.close();
    });
  }
}

// ================= MAIN =================
process.on('uncaughtException', (error) => {
  console.error("❌ Uncaught Exception:", error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("❌ Unhandled Rejection:", reason);
});

// Start bot
new BotWhatsApp().start().catch(e => {
  console.log("❌ FATAL ERROR:", e.message);
  process.exit(1);
});