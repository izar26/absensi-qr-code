const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { createQrWithImage } = require('./qr-helper');

let client;
let isReady = false;
let qrSentThisSession = false;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => 3000 + Math.random() * 4000;

const initializeWhatsApp = () => {
    const broadcast = global.broadcast;
    broadcast({ type: 'log', message: 'Mengecek koneksi ke database...', level: 'info' });
    broadcast({ type: 'status_update', component: 'database', status: 'connecting' });
    db.query('SELECT 1')
        .then(() => {
            broadcast({ type: 'log', message: '✅ Koneksi database berhasil.', level: 'success' });
            broadcast({ type: 'status_update', component: 'database', status: 'connected' });
            broadcast({ type: 'log', message: 'Menginisialisasi WhatsApp Bot...', level: 'info' });
            broadcast({ type: 'status_update', component: 'whatsapp', status: 'initializing' });
            client = new Client({ authStrategy: new LocalAuth(), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } });
            global.whatsappClient = client;
            let qrSentThisSession = false;
            client.on('qr', qr => {
                if (qrSentThisSession) return;
                broadcast({ type: 'status_update', component: 'whatsapp', status: 'qr' });
                broadcast({ type: 'qr', qrString: qr });
                qrSentThisSession = true;
            });
            client.on('ready', () => {
                isReady = true;
                broadcast({ type: 'status_update', component: 'whatsapp', status: 'connected' });
                broadcast({ type: 'ready' });
            });
            client.on('disconnected', () => {
                isReady = false;
                broadcast({ type: 'status_update', component: 'whatsapp', status: 'disconnected' });
                broadcast({ type: 'log', message: 'Koneksi WhatsApp terputus.', level: 'error' });
            });
            client.on('message', handleIncomingMessage);
            client.initialize().catch(err => {
                broadcast({ type: 'status_update', component: 'whatsapp', status: 'error' });
                broadcast({ type: 'log', message: `Gagal memulai WhatsApp: ${err.message}`, level: 'error' });
            });
        })
        .catch(err => {
            broadcast({ type: 'log', message: `❌ Gagal terhubung ke database: ${err.message}`, level: 'error' });
            broadcast({ type: 'status_update', component: 'database', status: 'error' });
        });
};
async function handleIncomingMessage(message) {
    const contactNumber = message.from.replace('@c.us', '');

    try {
        const [students] = await db.query(
            'SELECT id, name FROM students WHERE phone_number = ? AND photo_request_status = "PENDING"',
            [contactNumber]
        );
        if (students.length === 0) return;

        const student = students[0];

        // Skenario 1: Siswa membalas dengan FOTO
        if (message.hasMedia && message.type === 'image') {
            console.log(`Menerima foto yang valid dari ${student.name}. Memproses...`);
            const media = await message.downloadMedia();
            const uploadsDir = path.join(__dirname, 'public', 'uploads');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            
            const filename = `${student.id}${path.extname(media.filename || '.jpg')}`;
            const filePath = path.join(uploadsDir, filename);
            fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));

            await db.query('UPDATE students SET photo_url = ?, photo_request_status = "COMPLETED" WHERE id = ?', [filename, student.id]);

            await message.reply('Terima kasih! Foto profil Anda telah berhasil diperbarui. 👍\n\nSaya akan kirimkan QR Code baru Anda...');
            console.log(`Foto untuk ${student.name} berhasil disimpan. Membuat QR Code baru...`);

            const newQrCodeDataURL = await createQrWithImage(student.id, student.name, filename);
            await sendQrCode(contactNumber, newQrCodeDataURL, student.name, true);
        }
        // Skenario 2: Siswa membalas dengan teks "tidak"
        else if (message.type === 'chat' && message.body.trim().toLowerCase() === 'tidak') {
            console.log(`${student.name} menolak permintaan foto.`);
            await db.query('UPDATE students SET photo_request_status = "COMPLETED" WHERE id = ?', [student.id]);
            await message.reply('Baik, terima kasih atas konfirmasinya. Jika di kemudian hari Anda ingin menggunakan foto, silakan hubungi admin.');
        }

    } catch (error) {
        console.error("Error saat memproses pesan masuk:", error);
        await message.reply('Maaf, terjadi kesalahan di sistem kami.');
    }
};

const requestPhoto = async (number, studentName, isFirstRequest = false, isChangeRequest = false) => {
    if (!isReady) throw new Error('WhatsApp belum siap.');
    
    let message;
    if (isChangeRequest) {
        message = `Halo ${studentName},\n\nAdmin telah memulai permintaan untuk mengganti foto profil Anda di sistem absensi.\n\nSilakan balas pesan ini dengan mengirimkan *satu foto baru* Anda. Jika batal, cukup balas dengan kata: *tidak*`;
    } else if (isFirstRequest) {
        message = `Apakah Anda ingin menggunakan foto profil asli di QR Code? Jika ya, silakan kirim fotonya sekarang. Jika tidak, balas pesan ini dengan kata: *tidak*`;
    } else {
        message = `Halo ${studentName},\n\nSistem absensi kami memerlukan foto profil Anda.\n\nSilakan balas pesan ini dengan mengirimkan *satu foto terbaik* Anda. Jika tidak ingin, balas pesan ini dengan kata: *tidak*`;
    }
    
    await sendNotification(number, message);
};

// Sisa fungsi (sendNotification, sendQrCode, dll.)
const sendNotification = async (number, message) => {
    if (!isReady) return console.warn('WhatsApp belum siap. Pesan tidak terkirim.');
    try {
        const chatId = `${number}@c.us`;
        await client.sendMessage(chatId, message);
        console.log(`Pesan notifikasi berhasil terkirim ke ${number}`);
    } catch (error) {
        console.error(`Gagal mengirim pesan ke ${number}.`, error.message);
    }
};

// Perbarui fungsi sendQrCode untuk menangani pesan update
const sendQrCode = async (number, qrDataUrl, studentName, isUpdate = false) => {
    if (!isReady) return console.warn('WhatsApp belum siap. QR Code tidak terkirim.');
    try {
        const chatId = `${number}@c.us`;
        const caption = isUpdate 
            ? `Berikut adalah QR Code baru Anda dengan foto profil yang telah diperbarui. Gunakan yang ini untuk absensi selanjutnya ya!`
            : `Halo ${studentName},\n\nIni adalah QR Code pribadi Anda untuk absensi. Mohon simpan baik-baik.`;
        
        const base64Data = qrDataUrl.split(';base64,').pop();
        const media = new MessageMedia('image/png', base64Data, 'qr-code.png');
        await client.sendMessage(chatId, media, { caption: caption });
        console.log(`QR Code ${isUpdate ? 'pembaruan ' : ''}berhasil terkirim ke ${studentName}`);
    } catch (error) {
        console.error(`Gagal mengirim QR Code ke ${number}.`, error.message);
    }
};

const sendReportImage = async (number, imageDataUrl, caption) => {
    if (!isReady) {
        console.warn('WhatsApp belum siap. Laporan tidak terkirim.');
        throw new Error('WhatsApp client is not ready.');
    }
    try {
        const chatId = `${number}@c.us`;
        const base64Data = imageDataUrl.split(';base64,').pop();
        const media = new MessageMedia('image/jpeg', base64Data, 'laporan-absensi.jpg');
        await client.sendMessage(chatId, media, { caption: caption });
        console.log(`Laporan berhasil terkirim ke ${number}`);
    } catch (error) {
        console.error(`Gagal mengirim laporan ke ${number}.`, error.message);
        throw new Error(`Gagal mengirim laporan ke WhatsApp: ${error.message}`);
    }
};

const sendBroadcast = async (numbers, message) => {
    if (!isReady) throw new Error('WhatsApp belum siap. Broadcast dibatalkan.');
    console.log(`Memulai broadcast ke ${numbers.length} nomor...`);
    let successCount = 0;
    let failCount = 0;
    for (const number of numbers) {
        try {
            await sendNotification(number, message);
            successCount++;
        } catch (error) {
            failCount++;
            console.error(`Gagal mengirim ke ${number} saat broadcast:`, error.message);
        }
        await sleep(randomDelay());
    }
    console.log(`Broadcast selesai. Berhasil: ${successCount}, Gagal: ${failCount}`);
    return { successCount, failCount, total: numbers.length };
};


module.exports = { 
    initializeWhatsApp, sendNotification, sendQrCode, sendReportImage, 
    sendBroadcast, requestPhoto 
};

