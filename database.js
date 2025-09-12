const mysql = require('mysql2');

// Konfigurasi koneksi database
const dbConfig = {
    host: 'localhost',
    user: 'root', // Ganti dengan username database Anda
    password: '261426', // Ganti dengan password database Anda
    database: 'absensi_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Membuat connection pool
const pool = mysql.createPool(dbConfig);

// --- PENAMBAHAN KODE UNTUK CEK KONEKSI ---
// Fungsi async untuk melakukan tes koneksi
async function testConnection() {
    let connection;
    try {
        // Mencoba mendapatkan satu koneksi dari pool
        connection = await pool.promise().getConnection();
        console.log('✅ Berhasil terhubung ke database MySQL!');
    } catch (error) {
        console.error('❌ Gagal terhubung ke database MySQL.');
        console.error('Error:', error.message);
        // Keluar dari proses jika koneksi database gagal, karena aplikasi tidak bisa berjalan tanpanya.
        process.exit(1);
    } finally {
        // Selalu lepaskan koneksi setelah selesai pengecekan
        if (connection) connection.release();
    }
}

// Jalankan fungsi tes koneksi
testConnection();
// -----------------------------------------


// Ekspor versi promise dari pool agar bisa di-await di file lain
module.exports = pool.promise();

