const qrcode = require('qrcode');
const jimp = require('jimp');
const path = require('path');

/**
 * Fungsi cerdas untuk membuat QR Code dengan gambar di tengahnya.
 * Akan menggunakan foto asli jika ada, atau membuat avatar inisial jika tidak ada.
 * @param {string} studentId - ID unik siswa.
 * @param {string} studentName - Nama lengkap siswa.
 * @param {string|null} photoUrl - Nama file foto (e.g., 'siswa-xxx.jpg') atau null.
 * @returns {Promise<string>} Data URL Base64 dari gambar QR Code final.
 */
async function createQrWithImage(studentId, studentName, photoUrl) {
    // 1. Buat QR code mentah dengan level koreksi error tertinggi
    const qrCodeBuffer = await qrcode.toBuffer(studentId, {
        errorCorrectionLevel: 'H', margin: 2, width: 400
    });
    const qrImage = await jimp.read(qrCodeBuffer);

    // 2. Siapkan kanvas utama dan atasi nama yang panjang
    const font32 = await jimp.loadFont(jimp.FONT_SANS_32_BLACK);
    const font16 = await jimp.loadFont(jimp.FONT_SANS_16_BLACK);
    const textWidth = jimp.measureText(font32, studentName);
    const fontToUse = textWidth > qrImage.getWidth() - 20 ? font16 : font32;
    const textHeight = 50;
    
    const finalImage = new jimp(qrImage.getWidth(), qrImage.getHeight() + textHeight, '#ffffff');
    finalImage.print(fontToUse, 10, 10, { text: studentName, alignmentX: jimp.HORIZONTAL_ALIGN_CENTER }, finalImage.getWidth() - 20, textHeight);
    finalImage.composite(qrImage, 0, textHeight);

    let overlay;
    if (photoUrl) {
        // 3a. Jika ada foto, gunakan foto asli
        const photoPath = path.join(__dirname, 'public', 'uploads', photoUrl);
        // Cek jika file foto benar-benar ada
        if (require('fs').existsSync(photoPath)) {
            overlay = await jimp.read(photoPath);
        }
    } 
    
    if (!overlay) {
        // 3b. Jika tidak ada foto, buat avatar inisial
        const initials = studentName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        overlay = new jimp(120, 120, '#4f46e5'); // Lingkaran indigo
        const fontAvatar = await jimp.loadFont(jimp.FONT_SANS_64_WHITE);
        overlay.print(fontAvatar, 0, 0, { text: initials, alignmentX: jimp.HORIZONTAL_ALIGN_CENTER, alignmentY: jimp.VERTICAL_ALIGN_MIDDLE }, 120, 120);
    }

    // 4. Proses overlay (potong jadi lingkaran & tempel di tengah)
    overlay.resize(120, 120).circle();
    const x = (finalImage.getWidth() - overlay.getWidth()) / 2;
    const y = ((finalImage.getHeight() - textHeight - overlay.getHeight()) / 2) + textHeight;
    finalImage.composite(overlay, x, y);

    return await finalImage.getBase64Async(jimp.MIME_PNG);
}

module.exports = { createQrWithImage };
