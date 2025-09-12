const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('./database');
const { initializeWhatsApp, sendNotification, sendQrCode, sendReportImage, sendBroadcast, requestPhoto } = require('./whatsapp-bot');
const { createQrWithImage } = require('./qr-helper');
const multer = require('multer');
const crypto = require('crypto');

const app = express();

// --- Logika Server-Sent Events (SSE) ---
let sseClients = [];
const logHistory = [];
const MAX_LOG_HISTORY = 50;

const broadcast = (data) => {
    const sseData = `data: ${JSON.stringify(data)}\n\n`;
    if (data.type === 'log') {
        logHistory.push(data);
        if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift();
    }
    sseClients.forEach(client => client.res.write(sseData));
};
global.broadcast = broadcast;

// API Endpoint khusus untuk SSE stream
app.get('/api/status-stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    
    const clientId = Date.now();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);
    console.log(`Client baru terhubung ke SSE stream: ${clientId}`);

    const historyEvent = `data: ${JSON.stringify({ type: 'log_history', history: logHistory })}\n\n`;
    res.write(historyEvent);
    
    req.on('close', () => {
        console.log(`Client SSE terputus: ${clientId}`);
        sseClients = sseClients.filter(client => client.id !== clientId);
    });
});

// --- Inisialisasi Bot ---
initializeWhatsApp();

// --- Konfigurasi Multer & Middleware ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => { cb(null, `${req.newStudentId}${path.extname(file.originalname)}`); }
});
const upload = multer({ storage: storage });
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API Endpoints ---
app.get('/', (req, res) => res.redirect('/status.html'));

app.post('/api/logout', async (req, res) => {
    try {
        broadcast({ type: 'log', message: 'Memulai proses logout...', level: 'info' });
        const client = global.whatsappClient;
        if (client) {
            await client.destroy();
            broadcast({ type: 'log', message: 'Koneksi WhatsApp berhasil diputus.', level: 'success' });
        }
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(sessionPath)) { fs.rmSync(sessionPath, { recursive: true, force: true }); }
        broadcast({ type: 'log', message: 'Sesi lokal dihapus.', level: 'success' });
        broadcast({ type: 'logout' });
        res.status(200).json({ message: 'Logout berhasil. Memulai sesi baru...' });
        console.log('Memulai ulang inisialisasi bot...');
        broadcast({ type: 'log', message: 'Memulai sesi login baru...', level: 'info' });
        initializeWhatsApp();
    } catch (error) { res.status(500).json({ message: 'Gagal melakukan logout.' }); }
});

app.get('/api/server-info', (req, res) => {
    const networkInterfaces = os.networkInterfaces();
    let localIp = 'Tidak ditemukan';
    for (const name of Object.keys(networkInterfaces)) {
        for (const net of networkInterfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                localIp = net.address;
                break;
            }
        }
        if (localIp !== 'Tidak ditemukan') break;
    }
    res.json({ nodeVersion: process.version, platform: os.platform(), localIp: localIp });
});

// --- API BARU UNTUK KIRIM LAPORAN ---
app.post('/api/report/whatsapp', async (req, res) => {
    const { phoneNumber, imageData, reportDate } = req.body;
    if (!phoneNumber || !imageData || !reportDate) {
        return res.status(400).json({ message: 'Data tidak lengkap.' });
    }
    // Validasi sederhana nomor HP
    if (!phoneNumber.startsWith('62')) {
        return res.status(400).json({ message: 'Nomor WhatsApp harus diawali dengan 62.' });
    }

    try {
        const caption = `Berikut terlampir Laporan Absensi Harian untuk tanggal ${reportDate}.`;
        await sendReportImage(phoneNumber, imageData, caption);
        res.status(200).json({ message: `Laporan berhasil dikirim ke ${phoneNumber}` });
    } catch (error) {
        console.error("Gagal mengirim laporan via WhatsApp:", error);
        res.status(500).json({ message: error.message || 'Gagal mengirim laporan.' });
    }
});

// API UNTUK DASHBOARD
app.get('/api/dashboard/summary', async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);

        // 1. Hitung total siswa
        const [totalStudentsResult] = await db.query('SELECT COUNT(*) as count FROM students');
        const totalStudents = totalStudentsResult[0].count;

        // 2. Hitung yang sudah absen hari ini
        const [presentTodayResult] = await db.query('SELECT COUNT(*) as count FROM attendance WHERE attendance_date = ?', [today]);
        const presentToday = presentTodayResult[0].count;
        
        // 3. Hitung rincian status yang sudah absen
        const [statusBreakdownResult] = await db.query(
            'SELECT status, COUNT(*) as count FROM attendance WHERE attendance_date = ? GROUP BY status',
            [today]
        );
        
        const statusBreakdown = statusBreakdownResult.reduce((acc, row) => {
            acc[row.status] = row.count;
            return acc;
        }, {});

        res.json({
            totalStudents,
            presentToday,
            notPresentToday: totalStudents - presentToday,
            statusBreakdown
        });

    } catch (error) {
        console.error("Gagal mengambil data summary dashboard:", error);
        res.status(500).json({ message: 'Gagal mengambil data summary.' });
    }
});

// --- API SISWA (DIPERBARUI) ---
app.get('/api/students', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, name, phone_number, photo_url FROM students ORDER BY name ASC');
        res.json(rows);
    } catch (error) { res.status(500).json({ message: 'Gagal mengambil data siswa.' }); }
})

// API UNTUK TAMBAH SISWA BARU (DIPERBARUI)
app.post('/api/students', (req, res, next) => {
    // Sisipkan ID unik ke 'req' object, bukan 'req.body'
    req.newStudentId = `siswa-${crypto.randomUUID()}`;
    next();
}, upload.single('photo'), async (req, res) => {
    // Ambil ID dari 'req', bukan 'req.body'
    const newStudentId = req.newStudentId;
    const { name, phone_number } = req.body;
    const photoFile = req.file;

    if (!name) return res.status(400).json({ message: 'Nama siswa wajib diisi.' });

    try {
        const photo_url = photoFile ? photoFile.filename : null;
        const newStudent = { id: newStudentId, name, phone_number, photo_url };

        await db.query('INSERT INTO students (id, name, phone_number, photo_url) VALUES (?, ?, ?, ?)', [newStudent.id, newStudent.name, newStudent.phone_number, newStudent.photo_url]);

        if (phone_number) {
            (async () => {
                try {
                    const qrCodeDataURL = await createQrWithImage(newStudentId, name, photo_url);
                    await sendQrCode(phone_number, qrCodeDataURL, name);
                    if (!photo_url) {
                        await sleep(5000);
                        await db.query('UPDATE students SET photo_request_status = "PENDING" WHERE id = ?', [newStudentId]);
                        await requestPhoto(phone_number, name, true);
                    }
                } catch (waError) { console.error("Gagal mengirim data awal ke siswa via WA:", waError); }
            })();
        }
        res.status(201).json({ message: 'Siswa berhasil ditambahkan.', student: newStudent });
    } catch (error) {
        console.error("Gagal menambah siswa:", error);
        res.status(500).json({ message: 'Gagal menambah siswa ke database.' });
    }
});
app.put('/api/students/:id', upload.single('photo'), async (req, res) => {
    const { id } = req.params;
    const { name, phone_number } = req.body;
    const newPhotoFile = req.file; // File foto baru dari form (jika ada)

    if (!name) {
        return res.status(400).json({ message: 'Nama tidak boleh kosong.' });
    }

    try {
        // 1. Ambil data siswa yang sekarang untuk cek foto lama
        const [students] = await db.query('SELECT photo_url FROM students WHERE id = ?', [id]);
        if (students.length === 0) {
            // Hapus file yang mungkin terupload jika siswa tidak ditemukan
            if (newPhotoFile) fs.unlinkSync(newPhotoFile.path);
            return res.status(404).json({ message: 'Siswa tidak ditemukan.' });
        }
        const oldStudentData = students[0];
        
        let newPhotoUrl = oldStudentData.photo_url; // Defaultnya, kita pertahankan foto lama

        // 2. Jika ada foto baru yang di-upload, proses file tersebut
        if (newPhotoFile) {
            newPhotoUrl = newPhotoFile.filename; // Gunakan nama file yang baru dari multer

            // Hapus file foto lama dari server untuk menghemat ruang
            if (oldStudentData.photo_url) {
                const oldPhotoPath = path.join(__dirname, 'public', 'uploads', oldStudentData.photo_url);
                if (fs.existsSync(oldPhotoPath)) {
                    fs.unlinkSync(oldPhotoPath);
                    console.log(`Foto lama dihapus: ${oldStudentData.photo_url}`);
                }
            }
        }

        // 3. Update data siswa di database dengan informasi baru
        await db.query(
            'UPDATE students SET name = ?, phone_number = ?, photo_url = ? WHERE id = ?',
            [name, phone_number, newPhotoUrl, id]
        );

        // 4. FITUR BARU: Jika foto diubah, kirim QR Code baru secara otomatis
        if (newPhotoFile && phone_number) {
            console.log(`Foto untuk ${name} berubah, memproses pengiriman QR Code baru...`);
            
            // Proses ini berjalan di latar belakang agar tidak memperlambat respons ke admin
            (async () => {
                try {
                    const qrCodeDataURL = await createQrWithImage(id, name, newPhotoUrl);
                    await sendQrCode(phone_number, qrCodeDataURL, name, true); // `true` menandakan ini adalah update
                } catch (waError) {
                    console.error(`Gagal mengirim QR Code pembaruan ke ${name}:`, waError);
                }
            })();
        }
        
        res.status(200).json({ message: 'Data siswa berhasil diperbarui.' });

    } catch (error) {
        console.error("Gagal memperbarui data siswa:", error);
        // Hapus file yang terupload jika terjadi error di database
        if (newPhotoFile) fs.unlinkSync(newPhotoFile.path);
        res.status(500).json({ message: 'Terjadi kesalahan di server saat memperbarui data.' });
    }
});
app.delete('/api/students/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM students WHERE id = ?', [id]);
        res.json({ message: 'Siswa berhasil dihapus.' });
    } catch (error) { res.status(500).json({ message: 'Gagal menghapus siswa.' }); }
});

// API Sesi (CRUD)
app.get('/api/sessions', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM sessions ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) { res.status(500).json({ message: 'Gagal mengambil data sesi.' }); }
});
app.post('/api/sessions', async (req, res) => {
    const { session_name, late_time } = req.body;
    if (!session_name || !late_time) return res.status(400).json({ message: 'Nama sesi dan batas waktu telat wajib diisi.' });
    try {
        await db.query('INSERT INTO sessions (session_name, late_time) VALUES (?, ?)', [session_name, late_time]);
        res.status(201).json({ message: 'Sesi baru berhasil dibuat.' });
    } catch (error) { res.status(500).json({ message: 'Gagal membuat sesi.' }); }
});
app.put('/api/sessions/activate/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('UPDATE sessions SET is_active = 0');
        await db.query('UPDATE sessions SET is_active = 1 WHERE id = ?', [id]);
        res.json({ message: 'Sesi berhasil diaktifkan.' });
    } catch (error) { res.status(500).json({ message: 'Gagal mengaktifkan sesi.' }); }
});
app.delete('/api/sessions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const [sessions] = await db.query('SELECT is_active FROM sessions WHERE id = ?', [id]);
        if (sessions.length > 0 && sessions[0].is_active) {
            return res.status(400).json({ message: 'Sesi yang sedang aktif tidak dapat dihapus.' });
        }
        await db.query('DELETE FROM sessions WHERE id = ?', [id]);
        res.json({ message: 'Sesi berhasil dihapus.' });
    } catch (error) {
        if (error.code === 'ER_ROW_IS_REFERENCED_2') return res.status(400).json({ message: 'Gagal menghapus: Sesi ini sudah digunakan.' });
        res.status(500).json({ message: 'Gagal menghapus sesi.' });
    }
});

// API Absensi
app.post('/api/scan', async (req, res) => {
    const { studentId } = req.body;
    if (!studentId) return res.status(400).json({ message: 'ID Siswa tidak valid.' });
    try {
        const [activeSessions] = await db.query('SELECT * FROM sessions WHERE is_active = 1 LIMIT 1');
        if (activeSessions.length === 0) return res.status(400).json({ message: 'Tidak ada sesi absensi yang aktif.' });
        const activeSession = activeSessions[0];
        const [students] = await db.query('SELECT * FROM students WHERE id = ?', [studentId]);
        if (students.length === 0) return res.status(404).json({ message: 'Siswa tidak ditemukan.' });
        const student = students[0];
        const today = new Date().toISOString().slice(0, 10);
        const [existing] = await db.query('SELECT * FROM attendance WHERE student_id = ? AND attendance_date = ?', [studentId, today]);
        if (existing.length > 0) return res.status(409).json({ message: `${student.name} sudah tercatat absen hari ini.` });
        const now = new Date();
        const currentTime = now.toTimeString().slice(0, 8);
        const status = currentTime <= activeSession.late_time ? 'Tepat Waktu' : 'Terlambat';
        await db.query('INSERT INTO attendance (student_id, session_id, attendance_date, scan_time, status) VALUES (?, ?, ?, ?, ?)', [studentId, activeSession.id, today, currentTime, status]);
        if (student.phone_number) {
            const message = `✅ Absensi berhasil!\n\nNama: *${student.name}*\nWaktu: ${now.toLocaleTimeString('id-ID')}\nStatus: *${status}*\nSesi: ${activeSession.session_name}`;
            await sendNotification(student.phone_number, message);
        }
        res.status(200).json({ message: `Absensi ${student.name} berhasil. Status: ${status}` });
    } catch (error) { res.status(500).json({ message: 'Terjadi kesalahan di server.' }); }
});

app.post('/api/attendance/manual', async (req, res) => {
    const { studentId, status, date } = req.body;
    if (!studentId || !status || !date) return res.status(400).json({ message: 'Data tidak lengkap.' });
    try {
        const [activeSessions] = await db.query('SELECT * FROM sessions WHERE is_active = 1 LIMIT 1');
        if (activeSessions.length === 0) return res.status(400).json({ message: 'Tidak ada sesi absensi yang aktif.' });
        const activeSession = activeSessions[0];
        const [students] = await db.query('SELECT * FROM students WHERE id = ?', [studentId]);
        if (students.length === 0) return res.status(404).json({ message: 'Siswa tidak ditemukan.' });
        const student = students[0];
        const scanTime = (status === 'Hadir (Manual)') ? new Date().toTimeString().slice(0, 8) : null;
        const query = `
            INSERT INTO attendance (student_id, session_id, attendance_date, scan_time, status) VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE session_id = VALUES(session_id), scan_time = VALUES(scan_time), status = VALUES(status)`;
        await db.query(query, [studentId, activeSession.id, date, scanTime, status]);
        if (student.phone_number) {
            let message;
            const formattedDate = new Date(date + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
            switch (status) {
                case 'Hadir (Manual)': message = `✅ Absensi Manual berhasil!\n\nNama: *${student.name}*\nStatus: *Hadir (Manual)*\nTanggal: ${formattedDate}`; break;
                case 'Sakit': message = `ℹ️ Pemberitahuan Absensi\n\nNama: *${student.name}* telah dicatat *Sakit* untuk ${formattedDate}. Semoga lekas sembuh.`; break;
                case 'Izin': message = `ℹ️ Pemberitahuan Absensi\n\nNama: *${student.name}* telah dicatat *Izin* untuk ${formattedDate}.`; break;
                case 'Alfa': message = `⚠️ Peringatan Absensi!\n\nNama: *${student.name}* tercatat *ALFA* untuk ${formattedDate}. Mohon konfirmasi jika ada kekeliruan.`; break;
            }
            if (message) await sendNotification(student.phone_number, message);
        }
        res.status(200).json({ message: `Status absensi untuk ${student.name} berhasil diatur ke "${status}".` });
    } catch (error) { res.status(500).json({ message: 'Gagal menyimpan absensi manual.' }); }
});

app.delete('/api/attendance', async (req, res) => {
    const { studentId, date } = req.body;
    if (!studentId || !date) return res.status(400).json({ message: 'Data tidak lengkap.' });
    try {
        const [result] = await db.query('DELETE FROM attendance WHERE student_id = ? AND attendance_date = ?', [studentId, date]);
        if (result.affectedRows > 0) res.status(200).json({ message: 'Status absensi berhasil dibatalkan.' });
        else res.status(440).json({ message: 'Data absensi tidak ditemukan.' });
    } catch (error) { res.status(500).json({ message: 'Gagal membatalkan absensi.' }); }
});

app.get('/api/attendance/status', async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ message: 'Tanggal wajib diisi.' });
    try {
        const query = `
            SELECT s.id, s.name, a.status, a.scan_time FROM students s
            LEFT JOIN attendance a ON s.id = a.student_id AND a.attendance_date = ? ORDER BY s.name ASC`;
        const [rows] = await db.query(query, [date]);
        res.json(rows);
    } catch (error) { res.status(500).json({ message: 'Gagal mengambil data.' }); }
});

app.get('/api/attendance/today', async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const query = `
            SELECT s.name, a.scan_time as time, a.status FROM attendance a
            JOIN students s ON a.student_id = s.id
            WHERE a.attendance_date = ? AND a.scan_time IS NOT NULL ORDER BY a.scan_time DESC`;
        const [rows] = await db.query(query, [today]);
        res.json(rows);
    } catch (error) { res.status(500).json({ message: 'Gagal mengambil data absensi.' }); }
});

// API Peringkat
app.get('/api/rankings', async (req, res) => {
    const { period } = req.query;
    let whereClause = '';
    if (period === 'weekly') { whereClause = 'WHERE a.attendance_date >= CURDATE() - INTERVAL 6 DAY'; } 
    else if (period === 'monthly') { whereClause = 'WHERE MONTH(a.attendance_date) = MONTH(CURDATE()) AND YEAR(a.attendance_date) = YEAR(CURDATE())'; }
    try {
        const query = `
            SELECT s.id, s.name, SUM(CASE WHEN a.status = 'Tepat Waktu' THEN 2 WHEN a.status IN ('Terlambat', 'Hadir (Manual)') THEN 1 ELSE 0 END) as score
            FROM attendance a JOIN students s ON a.student_id = s.id ${whereClause}
            GROUP BY s.id, s.name HAVING score > 0 ORDER BY score DESC, s.name ASC LIMIT 10;`;
        const [rows] = await db.query(query);
        res.json(rows);
    } catch (error) { res.status(500).json({ message: 'Gagal mengambil data peringkat.' }); }
});

// API Statistik Detail (DIPERBARUI DENGAN LOGIKA LENCANA)
app.get('/api/student/:id/stats', async (req, res) => {
    const { id } = req.params;
    try {
        const [studentResult] = await db.query('SELECT name FROM students WHERE id = ?', [id]);
        if (studentResult.length === 0) return res.status(404).json({ message: 'Siswa tidak ditemukan.' });
        
        const studentName = studentResult[0].name;
        const [allAttendance] = await db.query('SELECT status FROM attendance WHERE student_id = ?', [id]);
        
        let badges = []; // Selalu inisialisasi sebagai array kosong
        const totalAttendance = allAttendance.length;

        if (totalAttendance > 0) {
            const hasPerfectAttendance = !allAttendance.some(a => ['Sakit', 'Izin', 'Alfa'].includes(a.status));
            const hasZeroLates = !allAttendance.some(a => a.status === 'Terlambat');
            if (hasPerfectAttendance) { badges.push({ name: 'Kehadiran Sempurna', icon: 'fas fa-check-circle', color: 'text-green-500', description: 'Tidak pernah absen (Sakit/Izin/Alfa).' }); }
            if (hasZeroLates) { badges.push({ name: 'Anti-Telat', icon: 'fas fa-star', color: 'text-yellow-500', description: 'Tidak pernah sekalipun tercatat terlambat.' }); }
        }

        const stats = allAttendance.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});
        const [trendResult] = await db.query(`SELECT attendance_date, status FROM attendance WHERE student_id = ? AND attendance_date >= CURDATE() - INTERVAL 30 DAY ORDER BY attendance_date ASC`, [id]);
        res.json({ name: studentName, stats, trend: trendResult, badges });
    } catch (error) { res.status(500).json({ message: 'Gagal mengambil data statistik.' }); }
});

// --- API BARU UNTUK BROADCAST ---
app.post('/api/broadcast', async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ message: 'Isi pesan tidak boleh kosong.' });
    }

    try {
        // Ambil semua nomor telepon yang valid dari database
        const [students] = await db.query('SELECT phone_number FROM students WHERE phone_number IS NOT NULL AND phone_number != ""');
        const numbers = students.map(s => s.phone_number);

        if (numbers.length === 0) {
            return res.status(404).json({ message: 'Tidak ada nomor kontak valid yang ditemukan di database.' });
        }

        // Jalankan broadcast dan tunggu hingga selesai
        const result = await sendBroadcast(numbers, message);

        res.status(200).json({ 
            message: `Broadcast selesai! Pesan berhasil terkirim ke ${result.successCount} dari ${result.total} kontak.` 
        });

    } catch (error) {
        console.error("Gagal menjalankan broadcast:", error);
        res.status(500).json({ message: error.message || 'Gagal menjalankan broadcast.' });
    }
});

// --- API BARU UNTUK REKAP BULANAN & EKSPOR ---
app.get('/api/report/monthly', async (req, res) => {
    const { year, month } = req.query;
    if (!year || !month) {
        return res.status(400).json({ message: 'Tahun dan bulan wajib diisi.' });
    }

    try {
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0); // Trik untuk mendapatkan hari terakhir
        const numDays = endDate.getDate();

        // 1. Ambil semua siswa
        const [students] = await db.query('SELECT id, name FROM students ORDER BY name ASC');
        if (students.length === 0) {
            return res.json({ headers: [], rows: [] });
        }

        // 2. Ambil semua data absensi di bulan tersebut
        const [attendances] = await db.query(
            'SELECT student_id, DAY(attendance_date) as day, status FROM attendance WHERE attendance_date BETWEEN ? AND ?',
            [startDate, endDate]
        );

        // 3. Olah data agar mudah diakses
        const attendanceMap = attendances.reduce((acc, curr) => {
            if (!acc[curr.student_id]) {
                acc[curr.student_id] = {};
            }
            acc[curr.student_id][curr.day] = curr.status;
            return acc;
        }, {});
        
        // Buat singkatan untuk status
        const statusMap = {
            'Tepat Waktu': 'H', 'Terlambat': 'T', 'Hadir (Manual)': 'H',
            'Sakit': 'S', 'Izin': 'I', 'Alfa': 'A'
        };

        // 4. Siapkan header tabel
        const dateHeaders = Array.from({ length: numDays }, (_, i) => `${i + 1}`);
        const summaryHeaders = ['Total Hadir', 'Total Sakit', 'Total Izin', 'Total Alfa', 'Total Terlambat'];
        const headers = ['Nama Siswa', ...dateHeaders, ...summaryHeaders];

        // 5. Buat baris data untuk setiap siswa
        const rows = students.map(student => {
            const row = { 'Nama Siswa': student.name };
            const summary = { 'Total Hadir': 0, 'Total Sakit': 0, 'Total Izin': 0, 'Total Alfa': 0, 'Total Terlambat': 0 };
            
            dateHeaders.forEach(day => {
                const studentAttendance = attendanceMap[student.id] || {};
                const status = studentAttendance[day];
                const shortStatus = status ? statusMap[status] : null;
                row[day] = shortStatus || '-';

                // Hitung rekap
                if (shortStatus === 'H' || shortStatus === 'T') summary['Total Hadir']++;
                if (shortStatus === 'S') summary['Total Sakit']++;
                if (shortStatus === 'I') summary['Total Izin']++;
                if (shortStatus === 'T') summary['Total Terlambat']++;
            });
            
            // Hitung alfa
            const totalAbsen = summary['Total Sakit'] + summary['Total Izin'];
            const totalMasuk = summary['Total Hadir'];
            // Asumsi hari kerja (bisa disesuaikan), misal 22 hari
            summary['Total Alfa'] = numDays - (totalMasuk + totalAbsen);
            
            return { ...row, ...summary };
        });

        res.json({ headers, rows });

    } catch (error) {
        console.error("Gagal membuat rekap bulanan:", error);
        res.status(500).json({ message: 'Gagal membuat rekap bulanan.' });
    }
});

// --- API MINTA FOTO (DIPERBARUI) ---
app.post('/api/students/:id/request-photo', async (req, res) => {
    const { id } = req.params;
    try {
        const [students] = await db.query('SELECT name, phone_number, photo_url, photo_request_status FROM students WHERE id = ?', [id]);
        if (students.length === 0) {
            return res.status(404).json({ message: 'Siswa tidak ditemukan.' });
        }
        const student = students[0];

        if (!student.phone_number) {
            return res.status(400).json({ message: 'Siswa ini tidak memiliki nomor WhatsApp terdaftar.' });
        }
        if (student.photo_request_status === 'PENDING') {
            return res.status(409).json({ message: 'Permintaan foto untuk siswa ini sudah dikirim dan sedang menunggu balasan.' });
        }

        // Tentukan apakah ini permintaan untuk mengganti foto
        const isChangeRequest = !!student.photo_url;

        await db.query('UPDATE students SET photo_request_status = "PENDING" WHERE id = ?', [id]);
        
        // Kirim permintaan via WhatsApp dengan konteks yang benar
        await requestPhoto(student.phone_number, student.name, false, isChangeRequest);

        res.status(200).json({ message: `Permintaan ${isChangeRequest ? 'ganti' : ''} foto berhasil dikirim ke ${student.name}.` });
    } catch (error) {
        console.error(`Gagal meminta foto untuk siswa ${id}:`, error);
        await db.query('UPDATE students SET photo_request_status = "IDLE" WHERE id = ?', [id]);
        res.status(500).json({ message: 'Gagal mengirim permintaan via WhatsApp.' });
    }
});

// API BARU: Untuk mereset status permintaan foto (jika perlu)
app.post('/api/students/:id/reset-status', async (req, res) => {
    const { id } = req.params;
    try {
        // Ganti status PENDING kembali ke IDLE atau NULL
        await db.query('UPDATE students SET photo_request_status = "IDLE" WHERE id = ?', [id]);
        res.status(200).json({ message: 'Status siswa berhasil direset.' });
    } catch (error) {
        res.status(500).json({ message: 'Gagal mereset status siswa.' });
    }
});

// API BARU: Untuk meminta foto secara massal (DIPERBARUI)
app.post('/api/students/bulk-request-photo', async (req, res) => {
    try {
        // --- PERUBAHAN LOGIKA DI SINI ---
        // Cari semua siswa yang belum punya foto DAN statusnya BUKAN 'PENDING'
        const [studentsToRequest] = await db.query(
            "SELECT id, name, phone_number FROM students WHERE photo_url IS NULL AND photo_request_status != 'PENDING' AND phone_number IS NOT NULL AND phone_number != ''"
        );

        if (studentsToRequest.length === 0) {
            return res.status(200).json({ message: 'Tidak ada siswa yang memenuhi syarat untuk diminta foto saat ini.' });
        }

        res.status(202).json({ 
            message: `Proses permintaan foto massal untuk ${studentsToRequest.length} siswa telah dimulai. Ini akan berjalan di latar belakang.` 
        });

        (async () => {
            console.log(`Memulai permintaan foto massal untuk ${studentsToRequest.length} siswa...`);
            for (const student of studentsToRequest) {
                try {
                    // Reset status menjadi PENDING sebelum mengirim
                    await db.query('UPDATE students SET photo_request_status = "PENDING" WHERE id = ?', [student.id]);
                    await requestPhoto(student.phone_number, student.name);
                    console.log(`Permintaan foto berhasil dikirim ke ${student.name}`);
                } catch (error) {
                    console.error(`Gagal mengirim permintaan ke ${student.name}:`, error.message);
                    await db.query('UPDATE students SET photo_request_status = "IDLE" WHERE id = ?', [student.id]);
                }
                await sleep(randomDelay());
            }
            console.log("Proses permintaan foto massal selesai.");
        })();

    } catch (error) {
        console.error("Gagal memulai proses permintaan foto massal:", error);
        if (!res.headersSent) {
            res.status(500).json({ message: 'Gagal memulai proses permintaan massal.' });
        }
    }
});

// API BARU: Untuk generate gambar QR Code berdasarkan ID
app.get('/api/qr-code/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const [students] = await db.query('SELECT name, photo_url FROM students WHERE id = ?', [id]);
        if (students.length === 0) {
            return res.status(404).json({ message: 'Siswa tidak ditemukan.' });
        }
        const student = students[0];
        const qrCodeDataURL = await createQrWithImage(id, student.name, student.photo_url);
        res.json({ qrData: qrCodeDataURL });
    } catch (error) {
        console.error("Gagal membuat gambar QR Code:", error);
        res.status(500).json({ message: 'Gagal membuat gambar QR Code.' });
    }
});

// API BARU: Untuk mengirim ulang QR Code via WA
app.post('/api/students/:id/resend-qr', async (req, res) => {
    const { id } = req.params;
    try {
        const [students] = await db.query('SELECT name, phone_number, photo_url FROM students WHERE id = ?', [id]);
        if (students.length === 0) return res.status(404).json({ message: 'Siswa tidak ditemukan.' });
        
        const student = students[0];
        if (!student.phone_number) return res.status(400).json({ message: 'Siswa ini tidak memiliki nomor WhatsApp.' });

        const qrCodeDataURL = await createQrWithImage(id, student.name, student.photo_url);
        await sendQrCode(student.phone_number, qrCodeDataURL, student.name, true); // true = isUpdate

        res.status(200).json({ message: `QR Code berhasil dikirim ulang ke ${student.name}.` });
    } catch (error) {
        console.error("Gagal mengirim ulang QR Code:", error);
        res.status(500).json({ message: 'Gagal mengirim ulang QR Code.' });
    }
});

// API BARU: Untuk verifikasi data siswa saat scan
app.get('/api/student/:id/details', async (req, res) => {
    const { id } = req.params;
    try {
        const [students] = await db.query('SELECT name, photo_url FROM students WHERE id = ?', [id]);
        if (students.length === 0) {
            return res.status(404).json({ message: 'Siswa dengan QR Code ini tidak ditemukan.' });
        }
        res.json(students[0]);
    } catch (error) {
        console.error("Gagal mengambil detail siswa:", error);
        res.status(500).json({ message: 'Gagal mengambil detail siswa.' });
    }
});

const port = 3000;
app.listen(port, '0.0.0.0', () => {
    const startMessage = `Server berjalan di http:localhost:${port}`;
    console.log(startMessage);
});

